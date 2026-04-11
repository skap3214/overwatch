#!/bin/bash
set -e

REPO="https://github.com/skap3214/overwatch.git"
INSTALL_DIR="$HOME/.overwatch/app"

echo ""
echo "  Overwatch Installer"
echo "  ────────────────────"
echo ""

# Check dependencies
for cmd in node npm git; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "  ✗ $cmd is required but not installed."
    exit 1
  fi
done

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "  ✗ Node.js 20+ required (found v$NODE_VERSION)"
  exit 1
fi

echo "  ✓ node $(node -v)"
echo "  ✓ npm $(npm -v)"
echo ""

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Updating existing installation..."
  cd "$INSTALL_DIR"
  git fetch --depth 1 origin main --quiet
  git reset --hard origin/main --quiet 2>/dev/null || git reset --hard FETCH_HEAD --quiet
else
  rm -rf "$INSTALL_DIR"
  echo "  Cloning overwatch..."
  git clone --quiet --depth 1 "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Install dependencies
echo "  Installing dependencies..."
npm install --silent 2>/dev/null

# Create the overwatch command
OVERWATCH_BIN="$HOME/.overwatch/bin"
mkdir -p "$OVERWATCH_BIN"

cat > "$OVERWATCH_BIN/overwatch" << 'SCRIPT'
#!/bin/bash
exec npx --prefix "$HOME/.overwatch/app" tsx "$HOME/.overwatch/app/packages/cli/src/index.ts" "$@"
SCRIPT
chmod +x "$OVERWATCH_BIN/overwatch"

cat > "$OVERWATCH_BIN/pi" << 'SCRIPT'
#!/bin/bash
exec npx --prefix "$HOME/.overwatch/app" @mariozechner/pi-coding-agent "$@"
SCRIPT
chmod +x "$OVERWATCH_BIN/pi"

# Add to PATH if not already there
SHELL_RC=""
if [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
fi

if [ -n "$SHELL_RC" ]; then
  if ! grep -q '.overwatch/bin' "$SHELL_RC" 2>/dev/null; then
    echo '' >> "$SHELL_RC"
    echo '# Overwatch CLI' >> "$SHELL_RC"
    echo 'export PATH="$HOME/.overwatch/bin:$PATH"' >> "$SHELL_RC"
  fi
fi

echo ""
echo "  ✓ Installed to ~/.overwatch/"
echo "  ✓ Added 'overwatch' to PATH"
echo ""

# Make overwatch available in the current shell immediately
export PATH="$HOME/.overwatch/bin:$PATH"

echo "  Note: if 'overwatch' is not found, run:"
echo "    export PATH=\"\$HOME/.overwatch/bin:\$PATH\""
echo ""

# Run setup immediately
overwatch setup
