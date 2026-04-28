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

refresh_npm_path() {
  NPM_GLOBAL_BIN="$(get_npm_global_bin)"
  if [ -n "$NPM_GLOBAL_BIN" ] && [ -d "$NPM_GLOBAL_BIN" ]; then
    export PATH="$NPM_GLOBAL_BIN:$PATH"
  fi
}

# Read the @mariozechner/pi-coding-agent version pinned in the Overwatch
# package.json so the global install picks the same line we test against.
# Pinning matters: with a global `before` / min-release-age npmrc policy and
# a package that publishes ~daily, an unpinned `npm install -g <pkg>` walks
# back through hundreds of versions and can hang for minutes.
get_pinned_pi_version() {
  local pkg_json="$INSTALL_DIR/package.json"
  [ -f "$pkg_json" ] || { echo ""; return; }
  node -e "
    try {
      const pkg = require('$pkg_json');
      const v = (pkg.dependencies && pkg.dependencies['@mariozechner/pi-coding-agent']) ||
                (pkg.devDependencies && pkg.devDependencies['@mariozechner/pi-coding-agent']);
      process.stdout.write(v ? String(v).replace(/^[\\^~]/, '') : '');
    } catch { process.stdout.write(''); }
  " 2>/dev/null
}

install_global_pi() {
  refresh_npm_path

  # 1. Skip if the user already has pi on PATH. No reason to reinstall.
  if command -v pi >/dev/null 2>&1; then
    local existing_version
    existing_version="$(pi --version 2>/dev/null | head -1 || echo unknown)"
    success "pi already installed ($(command -v pi), $existing_version)"
    return
  fi

  # 2. Allow opt-in / opt-out via env vars so curl-piped installs are scriptable.
  #    OVERWATCH_INSTALL_PI=1 → install without prompting
  #    OVERWATCH_INSTALL_PI=0 → skip without prompting
  local choice="${OVERWATCH_INSTALL_PI:-}"

  if [ -z "$choice" ]; then
    if [ -t 0 ] && [ -t 1 ]; then
      # Interactive — ask. Default = yes.
      printf "  Install pi-coding-agent globally now? [Y/n]: "
      local reply=""
      read -r reply || reply=""
      case "${reply:-y}" in
        [Nn]|[Nn][Oo]) choice="0" ;;
        *)             choice="1" ;;
      esac
    else
      # Non-interactive (curl | bash) — don't surprise the user. Skip and tell
      # them how to install later. They can re-run with OVERWATCH_INSTALL_PI=1.
      choice="0"
    fi
  fi

  if [ "$choice" != "1" ]; then
    say "Skipping pi install."
    say "Install later with one of:"
    say "  npm install -g @mariozechner/pi-coding-agent"
    say "  OVERWATCH_INSTALL_PI=1 bash $0   # re-run this installer"
    return
  fi

  # 3. Use the recommended install command, pinned to the version Overwatch
  #    was built against. This avoids the release-age-walk hang.
  local pinned
  pinned="$(get_pinned_pi_version)"
  local target="@mariozechner/pi-coding-agent"
  if [ -n "$pinned" ]; then
    target="@mariozechner/pi-coding-agent@$pinned"
    say "Installing pi globally ($target)..."
  else
    say "Installing pi globally (latest — no pinned version found)..."
  fi

  if ! npm install -g "$target"; then
    warn "pi global install failed."
    warn "If your npmrc enforces a minimum release age, the latest version may be"
    warn "blocked. Try pinning an older version explicitly:"
    warn "  npm view @mariozechner/pi-coding-agent versions --json | tail -20"
    warn "  npm install -g @mariozechner/pi-coding-agent@<version>"
    return
  fi

  refresh_npm_path

  if command -v pi >/dev/null 2>&1; then
    success "pi installed globally ($(command -v pi))"
    return
  fi

  warn "pi installed globally, but the npm global bin directory is not on PATH yet."
  warn "Open a new shell, or add the npm global bin to your PATH manually:"
  warn "  export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
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
