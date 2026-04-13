#!/bin/bash
set -euo pipefail

REPO="https://github.com/skap3214/overwatch.git"
INSTALL_ROOT="$HOME/.overwatch"
INSTALL_DIR="$INSTALL_ROOT/app"
BIN_DIR="$INSTALL_ROOT/bin"

say() {
  echo "  $1"
}

success() {
  say "✓ $1"
}

warn() {
  say "! $1"
}

fail() {
  say "✗ $1"
  exit 1
}

brew_shellenv() {
  if command -v brew >/dev/null 2>&1; then
    eval "$(brew shellenv)"
    return 0
  fi
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    return 0
  fi
  if [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
    return 0
  fi
  return 1
}

ensure_homebrew() {
  if brew_shellenv; then
    success "Homebrew ready"
    return
  fi

  warn "Homebrew not found. Installing it now..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  brew_shellenv || fail "Homebrew installed but could not be loaded into PATH"
  success "Homebrew installed"
}

ensure_brew_formula() {
  local formula="$1"
  if brew list --versions "$formula" >/dev/null 2>&1; then
    success "$formula already installed"
    return
  fi

  warn "Installing $formula..."
  brew install "$formula"
  success "$formula installed"
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -v | cut -d'v' -f2 | cut -d'.' -f1)"
    if [ "$major" -ge 20 ]; then
      success "node $(node -v)"
      success "npm $(npm -v)"
      return
    fi
    warn "Node.js $(node -v) is too old. Upgrading via Homebrew..."
  fi

  ensure_brew_formula node
  local major
  major="$(node -v | cut -d'v' -f2 | cut -d'.' -f1)"
  [ "$major" -ge 20 ] || fail "Node.js 20+ required after install (found $(node -v))"
  success "node $(node -v)"
  success "npm $(npm -v)"
}

get_npm_global_bin() {
  local prefix
  prefix="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$prefix" ]; then
    echo "$prefix/bin"
    return
  fi
  if command -v npm >/dev/null 2>&1; then
    npm config get prefix 2>/dev/null | sed 's#/*$##' | awk '{print $0 "/bin"}'
    return
  fi
  echo ""
}

ensure_shell_path() {
  local overwatch_line='export PATH="$HOME/.overwatch/bin:$PATH"'
  local npm_bin_line=""
  local npm_global_bin="$1"
  local marker="# Overwatch CLI"
  local files=()

  if [ -n "$npm_global_bin" ]; then
    npm_bin_line="export PATH=\"$npm_global_bin:\$PATH\""
  fi

  case "${SHELL##*/}" in
    zsh)
      files+=("$HOME/.zprofile")
      ;;
    bash)
      files+=("$HOME/.bash_profile")
      ;;
    *)
      files+=("$HOME/.profile")
      ;;
  esac

  for rc in "${files[@]}"; do
    [ -f "$rc" ] || touch "$rc"
    if ! grep -qF "$overwatch_line" "$rc" 2>/dev/null; then
      {
        echo ""
        echo "$marker"
        echo "$overwatch_line"
      } >> "$rc"
    fi
    if [ -n "$npm_bin_line" ] && ! grep -qF "$npm_bin_line" "$rc" 2>/dev/null; then
      {
        echo "$npm_bin_line"
      } >> "$rc"
    fi
  done
}

create_overwatch_wrapper() {
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/overwatch" << 'SCRIPT'
#!/bin/bash
set -euo pipefail
APP_ROOT="$HOME/.overwatch/app"
exec "$APP_ROOT/node_modules/.bin/tsx" "$APP_ROOT/packages/cli/src/index.ts" "$@"
SCRIPT
  chmod +x "$BIN_DIR/overwatch"
}

install_global_pi() {
  say "Installing pi globally..."
  npm install -g @mariozechner/pi-coding-agent

  NPM_GLOBAL_BIN="$(get_npm_global_bin)"

  if [ -n "$NPM_GLOBAL_BIN" ] && [ -d "$NPM_GLOBAL_BIN" ]; then
    export PATH="$NPM_GLOBAL_BIN:$PATH"
  fi

  if command -v pi >/dev/null 2>&1; then
    success "pi installed globally ($(command -v pi))"
    return
  fi

  warn "pi installed globally, but the npm global bin directory is not on PATH yet."
}

install_app() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    say "Updating existing installation..."
    cd "$INSTALL_DIR"
    git fetch --depth 1 origin main --quiet
    git reset --hard origin/main --quiet 2>/dev/null || git reset --hard FETCH_HEAD --quiet
  else
    rm -rf "$INSTALL_DIR"
    say "Cloning overwatch..."
    git clone --quiet --depth 1 "$REPO" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi

  say "Installing app dependencies..."
  npm ci --no-audit --no-fund
}

echo ""
echo "  Overwatch Installer"
echo "  ────────────────────"
echo ""

[ "$(uname -s)" = "Darwin" ] || fail "Overwatch installer currently supports macOS only"

ensure_homebrew
ensure_brew_formula git
ensure_brew_formula tmux
ensure_node

install_app
create_overwatch_wrapper
NPM_GLOBAL_BIN=""
install_global_pi
ensure_shell_path "$NPM_GLOBAL_BIN"

export PATH="$BIN_DIR:$PATH"
if [ -n "$NPM_GLOBAL_BIN" ] && [ -d "$NPM_GLOBAL_BIN" ]; then
  export PATH="$NPM_GLOBAL_BIN:$PATH"
fi

echo ""
success "Installed to ~/.overwatch/"
success "Added 'overwatch' to your shell PATH"
if command -v pi >/dev/null 2>&1; then
  success "pi is available as a global command"
else
  warn "pi may need a new shell before it is available as a global command"
fi
echo ""
say "Next steps:"
say "1. Run: overwatch setup"
say "2. Then: overwatch start"
echo ""
say "If your current shell cannot find 'overwatch' yet, run:"
say "export PATH=\"\$HOME/.overwatch/bin:\$PATH\""
if ! command -v pi >/dev/null 2>&1 && [ -n "$NPM_GLOBAL_BIN" ]; then
  say "If your current shell cannot find 'pi' yet, run:"
  say "export PATH=\"$NPM_GLOBAL_BIN:\$PATH\""
fi
echo ""
