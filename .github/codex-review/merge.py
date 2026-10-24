#!/usr/bin/env python3
"""Decide whether the AI review gate may squash-merge a same-repo PR.

The review payload is read from an artifact file (REVIEW_ARTIFACT). It must
not be passed through a job output: Actions drops outputs it suspects contain
a secret, and the gate then sees an empty review.

Owner path: OWNER_LOGIN + same repository + merge_recommendation safe_to_merge
may merge without the bot-automerge label, including when non-secret protected
paths changed. Secret-material paths still block and receive needs-human.
Forks are not checked out here; this script only talks to the GitHub API.
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from review_json import load_last_verdict  # noqa: E402


def gh(*args, check=True):
    result = subprocess.run(["gh", *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise SystemExit(f"gh {' '.join(args[:3])} failed")
    return result.stdout


def api(path):
    return json.loads(gh("api", path))


def short(text, limit=120):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def enum_field(review, key, allowed):
    value = str(review.get(key, "")).strip() if isinstance(review, dict) else ""
    if value in allowed:
        return value
    return "缺失" if not value else "非法"


def verdict(review):
    if not review:
        return "无审核结果"
    recommendation = enum_field(
        review, "merge_recommendation", {"safe_to_merge", "merge_with_caution", "changes_required"},
    )
    risk = enum_field(review, "risk_level", {"low", "medium", "high"})
    return f"{recommendation} / 风险 {risk}"


def protected(name, pattern):
    base = name.rsplit("/", 1)[-1]
    if pattern.endswith("/"):
        return ("/" + name).find("/" + pattern) >= 0
    if pattern.startswith("*"):
        return name.endswith(pattern[1:])
    return base.startswith(pattern)


def matching(names, patterns):
    return [name for name in names if any(protected(name, pattern) for pattern in patterns)]


def is_secret_material(name):
    """Secret paths match a path segment, not only the file basename.

    `secrets` and `credentials` match any exact segment, so
    `.github/secrets/production.json` is included. `.env*` and `id_rsa*` match
    a segment prefix. `*.pem`, `*.key`, and `*.p12` match a segment suffix.
    """
    parts = [part for part in name.split("/") if part not in ("", ".", "..")]
    if not parts:
        return False
    if any(part in ("secrets", "credentials") for part in parts):
        return True
    base = parts[-1]
    if base.startswith((".env", "id_rsa", "secrets", "credentials")):
        return True
    return base.endswith((".pem", ".key", ".p12"))


def secret_matching(names, patterns):
    return [
        name for name in names
        if is_secret_material(name) or any(protected(name, pattern) for pattern in patterns)
    ]


def change_paths(entry):
    """Current path, previous path on rename, and the path of a removed file.

    Renaming into or out of a secret path both count. Removed files use filename,
    and previous_filename when the API provides it.
    """
    paths = []
    if isinstance(entry, str):
        entry = {"filename": entry}
    if not isinstance(entry, dict):
        return paths
    for key in ("filename", "previous_filename"):
        value = str(entry.get(key) or "").strip()
        if value and value not in paths:
            paths.append(value)
    return paths


def path_block_reason(names, protected_patterns, secret_patterns, owner_verdict_path, secret_names=None):
    """Block secret paths always. Other protected paths block except on the owner path.

    owner_verdict_path is same-repo OWNER_LOGIN and merge_recommendation safe_to_merge.
    secret_names includes previous_filename and removed paths; names is the current paths
    used for the non-secret protected-path rule.
    """
    secret_hit = secret_matching(names if secret_names is None else secret_names, secret_patterns)
    protected_hit = matching(names, protected_patterns)
    if owner_verdict_path:
        if secret_hit:
            return "改动了密钥材料路径：" + ", ".join(secret_hit[:10]), secret_hit, protected_hit
        return None, secret_hit, protected_hit
    if protected_hit:
        return "改动了受保护路径：" + ", ".join(protected_hit[:10]), secret_hit, protected_hit
    if secret_hit:
        return "改动了密钥材料路径：" + ", ".join(secret_hit[:10]), secret_hit, protected_hit
    return None, secret_hit, protected_hit


def split_patterns(raw):
    return [item.strip() for item in raw.split(",") if item.strip()]


def write_summary(env, text):
    path = env.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(text)
    except OSError:
        pass


def die(env, message):
    print(message, file=sys.stderr)
    write_summary(env, f"## AI 审核闸门失败\n\n{message}\n")
    raise SystemExit(1)


def main():
    env = os.environ
    repo, pr, sha = env["REPO"], env["PR"], env["HEAD_SHA"]
    label, block = env["AUTOMERGE_LABEL"], env["BLOCK_LABEL"]
    artifact = env.get("REVIEW_ARTIFACT", "")
    review = {}

    file_ok = bool(artifact) and os.path.isfile(artifact) and os.path.getsize(artifact) > 0
    if env.get("REVIEW_RESULT") == "success" and not file_ok:
        folder = os.path.dirname(artifact) or "."
        found = sorted(os.listdir(folder))[:20] if os.path.isdir(folder) else []
        listing = ", ".join(found) or "（空或不存在）"
        download = env.get("REVIEW_DOWNLOAD") or "未知"
        die(
            env,
            "AI 审核任务已成功，但没有拿到审核结果文件（artifact 缺失或下载失败）。"
            "结果改为经 artifact 传递，避免 GitHub 因疑似 secret 丢弃 job output 后变成空结论。"
            f" 下载步骤={download}；期望文件：{os.path.basename(artifact) or 'review.json'}；目录内容：{listing}",
        )

    parse_error = None
    if file_ok:
        try:
            review = load_last_verdict(Path(artifact).read_text(encoding="utf-8"))
        except ValueError as exc:
            parse_error = str(exc)
            if env.get("REVIEW_RESULT") == "success":
                die(env, parse_error)

    issues = review.get("key_issues_to_review") if isinstance(review, dict) else None
    issue_count = len(issues) if isinstance(issues, list) else 0
    if parse_error:
        summary = f"## AI 审核结论\n\n解析失败：{parse_error}\n"
    else:
        summary = (
            "## AI 审核结论\n\n"
            "- merge_recommendation="
            + enum_field(review, "merge_recommendation", {"safe_to_merge", "merge_with_caution", "changes_required"})
            + "\n- risk_level="
            + enum_field(review, "risk_level", {"low", "medium", "high"})
            + f"\n- key_issues={issue_count}\n"
        )
    write_summary(env, summary)

    def block_merge(reasons):
        gh(
            "label", "create", block, "-R", repo, "--color", "B60205",
            "--description", "AI 闸门判定需要人工处理", check=False,
        )
        gh("api", "-X", "POST", f"repos/{repo}/issues/{pr}/labels", "-f", f"labels[]={block}", check=False)
        reasons = sorted(reasons, key=lambda item: item.startswith(("合并建议不是", "风险等级不是")))
        lines = [f"- {short(item)}" for item in reasons[:3]]
        if len(reasons) > 3:
            lines.append(f"- 另有 {len(reasons) - 3} 条，见 Actions 运行摘要")
        body = (
            f"### 🤖 自动合并已拦截\n结论：{verdict(review)}\n"
            + "\n".join(lines)
            + f"\n\n审核提交：`{sha[:7]}`"
        )
        gh("pr", "comment", pr, "-R", repo, "--body", body, check=False)
        print("BLOCKED:", reasons)
        raise SystemExit(0)

    info = api(f"repos/{repo}/pulls/{pr}")
    labels = {item["name"] for item in info["labels"]}
    author = info["user"]["login"]
    head_repo = ((info.get("head") or {}).get("repo") or {}).get("full_name")
    owner_same_repo = author == env.get("OWNER_LOGIN", "eachann1024") and head_repo == repo
    recommendation = str(review.get("merge_recommendation", "")).strip() if review else ""
    owner_verdict_path = owner_same_repo and recommendation == "safe_to_merge"

    # 没有自动合并标签，且不是主人 safe_to_merge：只审核不合并。
    if label not in labels and not owner_verdict_path:
        print("no automerge label; review only")
        return
    if info["state"] != "open" or info["head"]["sha"] != sha:
        print("PR closed or head moved; a newer run will handle it")
        return

    allowed = {item.strip() for item in env["ALLOWED_AUTHORS"].split(",") if item.strip()}
    if author not in allowed:
        # 不是仓库主人的 PR：只审不合，也不发评论。fork 同样走不到合并。
        print("author not allowed; review only")
        return

    reasons = []
    if env.get("REVIEW_RESULT") != "success":
        reasons.append(f"AI 审核未成功完成（{env.get('REVIEW_RESULT')}），按规则不自动合并")
    if parse_error:
        reasons.append(parse_error)
    elif not review:
        reasons.append("没有拿到 AI 审核的结构化结果")
    else:
        risk = str(review.get("risk_level", "")).strip().lower()
        # Actions 把 PR-Agent YAML 里的 No 编进 JSON 时会变成布尔 false，不能当安全疑虑。
        security_raw = review.get("security_concerns", None)
        if isinstance(security_raw, bool):
            security_text = "true" if security_raw else "false"
            security_clear = not security_raw
        else:
            security_text = str(security_raw or "").strip()
            lowered = security_text.lower()
            security_clear = lowered.startswith("no") or lowered in {"false", "none", "null"}
        ok_recommendations = {"safe_to_merge"} | (
            {"merge_with_caution"} if env.get("ALLOW_CAUTION") == "true" else set()
        )
        if recommendation not in ok_recommendations:
            allowed = "safe_to_merge 或 merge_with_caution" if env.get("ALLOW_CAUTION") == "true" else "safe_to_merge"
            reasons.append(f"合并建议不是 {allowed}")
        if risk not in {"low", "medium"}:
            reasons.append("风险等级不是 low 或 medium")
        if security_raw is None or (not isinstance(security_raw, bool) and not security_text):
            reasons.append("安全审查字段缺失")
        elif not security_clear:
            reasons.append("存在安全疑虑")
        issues = review.get("key_issues_to_review") or []
        if not isinstance(issues, list):
            issues = []
        # 不用裸「安全」：建议里的「并发安全/线程安全」不是安全漏洞。评论和日志不引用原文。
        fatal_kw = re.compile(
            r"安全漏洞|安全隐患|安全问题|安全风险|不安全|安全性|漏洞|注入|泄露|密钥|令牌|凭据|鉴权|认证|授权|越权|权限|计费|扣费|支付|账单|"
            r"数据(丢失|损坏|泄露|删除|清空|覆盖)|丢数据|迁移|schema|"
            r"\b(security|vulnerab\w*|injection|secret|credential|authn|authz|authenticat\w*|authoriz\w*|"
            r"permission|billing|payment|migration|data loss|corrupt\w*)\b",
            re.I,
        )
        fatal_count = 0
        for issue in issues:
            if isinstance(issue, dict):
                text = f"{issue.get('issue_header', '')} {issue.get('issue_content', '')}"
                if fatal_kw.search(text):
                    fatal_count += 1
        if fatal_count:
            reasons.append(f"审核意见涉及安全/鉴权/计费/数据/迁移（{fatal_count} 条）")
        if recommendation == "changes_required":
            change_count = sum(isinstance(issue, dict) for issue in issues)
            if change_count:
                reasons.append(f"要改：{change_count} 条")
    if any("security" in item.lower() for item in labels):
        reasons.append("PR 带有安全疑虑标签")

    files = json.loads(gh("api", "--paginate", "--slurp", f"repos/{repo}/pulls/{pr}/files?per_page=100"))
    entries = [item for page in files for item in page]
    names = [path for item in entries for path in change_paths(item)[:1]]
    secret_names = []
    for item in entries:
        for path in change_paths(item):
            if path not in secret_names:
                secret_names.append(path)
    protected_patterns = split_patterns(env.get("PROTECTED_PATHS", ""))
    secret_patterns = split_patterns(env.get("SECRET_PATHS", ""))
    if not secret_patterns:
        die(env, "SECRET_PATHS 未配置，无法判断密钥材料路径")
    reason, secret_hit, protected_hit = path_block_reason(
        names, protected_patterns, secret_patterns, owner_verdict_path, secret_names,
    )
    if owner_verdict_path:
        bypassed = [name for name in protected_hit if name not in set(secret_hit)]
        if bypassed:
            print("owner safe_to_merge; protected paths do not block:", ", ".join(bypassed[:10]))
    if reason:
        reasons.append(reason)

    if reasons:
        block_merge(reasons)

    own = {"ai-review", "ai-merge-gate"}
    deadline = time.time() + int(env["CHECKS_TIMEOUT_MIN"]) * 60
    while True:
        runs = api(f"repos/{repo}/commits/{sha}/check-runs?per_page=100")["check_runs"]
        runs = [item for item in runs if item["name"] not in own]
        status = api(f"repos/{repo}/commits/{sha}/status")
        pending = [item["name"] for item in runs if item["status"] != "completed"] + [
            item["context"] for item in status["statuses"] if item["state"] == "pending"
        ]
        bad = [
            f"{item['name']}={item['conclusion']}"
            for item in runs
            if item["status"] == "completed" and item["conclusion"] not in ("success", "skipped", "neutral")
        ] + [
            f"{item['context']}={item['state']}"
            for item in status["statuses"]
            if item["state"] in ("failure", "error")
        ]
        if bad:
            block_merge(["其他检查未通过：" + ", ".join(bad[:10])])
        if not pending:
            break
        if time.time() > deadline:
            block_merge([f"等待检查超过 {env['CHECKS_TIMEOUT_MIN']} 分钟（{', '.join(pending[:10])}），超时不合并"])
        time.sleep(30)

    for _ in range(10):
        info = api(f"repos/{repo}/pulls/{pr}")
        if info["mergeable"] is not None:
            break
        time.sleep(6)
    if info["head"]["sha"] != sha:
        print("head moved while waiting; skip")
        return
    if info["mergeable"] is not True:
        block_merge([
            f"PR 当前不可合并（mergeable={info['mergeable']}, state={info.get('mergeable_state')}），可能有冲突"
        ])

    result = subprocess.run(
        ["gh", "pr", "merge", pr, "-R", repo, "--squash", "--delete-branch", "--match-head-commit", sha],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        block_merge([f"合并调用失败：{(result.stderr or result.stdout).strip()[:300]}"])
    gh(
        "pr", "comment", pr, "-R", repo, "--body",
        f"✅ AI 审核通过（{verdict(review)}），已自动合并 `{sha[:7]}`",
        check=False,
    )
    print("MERGED", repo, pr, sha)


if __name__ == "__main__":
    main()
