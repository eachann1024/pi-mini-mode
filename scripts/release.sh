#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
REGISTRY="https://registry.npmjs.org"

echo "==> Package: ${NAME}@${VERSION}"

if npm view "${NAME}@${VERSION}" version --registry="$REGISTRY" >/dev/null 2>&1; then
  NEXT="$(node -p "
    const [a,b,c] = require('./package.json').version.split('.').map(Number);
    [a,b,c+1].join('.');
  ")"
  echo "==> ${NAME}@${VERSION} already on npm; bumping to ${NEXT}"
  npm version "$NEXT" --no-git-tag-version
  VERSION="$NEXT"
fi

echo "==> Running compile check..."
npm run check

echo "==> Running tests..."
npm test

echo "==> Committing release artifacts..."
# Only stage intentional release files; never force-add ignored secrets like .npmrc
git add package.json scripts/release.sh
if [ -f package-lock.json ] && [ -n "$(git status --porcelain package-lock.json)" ]; then
  git add package-lock.json
fi
if [ -n "$(git status --porcelain -- package.json package-lock.json scripts/release.sh)" ]; then
  git commit -m "chore: release $(node -p "require('./package.json').version")"
fi

echo "==> Pushing to remote..."
git push origin "$(git branch --show-current)"

echo "==> Publishing to npm..."
npm publish --access public --registry="$REGISTRY"

echo "==> Verifying release..."
sleep 5
npm view "$NAME" version dist-tags time --json --registry="$REGISTRY"

echo "==> Done! Published ${NAME}@$(node -p "require('./package.json').version")"
