#!/usr/bin/env bash
# install-prereqs.sh — Bootstrap script for LocalClaw
#
# Detects the OS, installs missing prerequisites (git, curl, Homebrew, Node.js,
# pnpm, Ollama), then builds the application.
#
# Usage:
#   bash scripts/install-prereqs.sh          # full install + build
#   bash scripts/install-prereqs.sh --check  # check only, no install
#
# Supports: macOS (Homebrew), Debian/Ubuntu (apt), Fedora/RHEL (dnf/yum),
#           Arch (pacman).

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { printf "${BLUE}▸${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}✓${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${NC} %s\n" "$*"; }
err()   { printf "${RED}✗${NC} %s\n" "$*" >&2; }
header() { printf "\n${BOLD}── %s ──${NC}\n\n" "$*"; }

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=true
fi

# ── OS Detection ──────────────────────────────────────────────────────────────

detect_os() {
  local uname_s
  uname_s="$(uname -s)"
  case "$uname_s" in
    Darwin) echo "macos" ;;
    Linux)  echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unknown" ;;
  esac
}

detect_linux_distro() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "$ID" in
      ubuntu|debian|pop|linuxmint|elementary|zorin) echo "debian" ;;
      fedora|rhel|centos|rocky|alma|ol) echo "fedora" ;;
      arch|manjaro|endeavouros) echo "arch" ;;
      opensuse*|sles) echo "suse" ;;
      *) echo "unknown" ;;
    esac
  else
    echo "unknown"
  fi
}

OS="$(detect_os)"
if [[ "$OS" == "linux" ]]; then
  DISTRO="$(detect_linux_distro)"
else
  DISTRO=""
fi

header "LocalClaw Prerequisite Installer"
info "OS: $OS${DISTRO:+ ($DISTRO)}"

if [[ "$OS" == "windows" ]]; then
  err "Windows is not directly supported. Use WSL2 instead:"
  err "  wsl --install"
  err "Then run this script inside WSL."
  exit 1
fi

if [[ "$OS" == "unknown" ]]; then
  err "Unsupported OS: $(uname -s)"
  exit 1
fi

# ── Helper: check if a command exists ─────────────────────────────────────────

has() { command -v "$1" &>/dev/null; }

# ── Helper: install a package ─────────────────────────────────────────────────

pkg_install() {
  local pkg="$1"
  info "Installing $pkg..."
  if [[ "$OS" == "macos" ]]; then
    brew install "$pkg"
  elif [[ "$DISTRO" == "debian" ]]; then
    sudo apt-get update -qq && sudo apt-get install -y -qq "$pkg"
  elif [[ "$DISTRO" == "fedora" ]]; then
    if has dnf; then
      sudo dnf install -y -q "$pkg"
    else
      sudo yum install -y -q "$pkg"
    fi
  elif [[ "$DISTRO" == "arch" ]]; then
    sudo pacman -S --noconfirm --needed "$pkg"
  elif [[ "$DISTRO" == "suse" ]]; then
    sudo zypper install -y "$pkg"
  else
    err "Cannot auto-install $pkg on this distro. Install it manually."
    return 1
  fi
}

# ── Track status ──────────────────────────────────────────────────────────────

MISSING=()
INSTALLED=()

check_or_install() {
  local name="$1"
  local install_name="${2:-$1}"

  if has "$name"; then
    ok "$name found: $(command -v "$name")"
    return 0
  fi

  MISSING+=("$name")
  if $CHECK_ONLY; then
    warn "$name: NOT FOUND"
    return 0
  fi

  pkg_install "$install_name"
  if has "$name"; then
    ok "$name installed successfully"
    INSTALLED+=("$name")
  else
    err "Failed to install $name"
    return 1
  fi
}

# ── Step 1: Homebrew (macOS only) ─────────────────────────────────────────────

if [[ "$OS" == "macos" ]]; then
  header "Homebrew"
  if has brew; then
    ok "Homebrew found: $(brew --prefix)"
  else
    MISSING+=("brew")
    if $CHECK_ONLY; then
      warn "Homebrew: NOT FOUND"
    else
      info "Installing Homebrew..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      # Add Homebrew to PATH for the rest of this script
      if [[ -f /opt/homebrew/bin/brew ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
      elif [[ -f /usr/local/bin/brew ]]; then
        eval "$(/usr/local/bin/brew shellenv)"
      fi
      if has brew; then
        ok "Homebrew installed"
        INSTALLED+=("brew")
      else
        err "Homebrew installation failed"
        exit 1
      fi
    fi
  fi
fi

# ── Step 2: Core utilities ────────────────────────────────────────────────────

header "Core utilities"
check_or_install git
check_or_install curl

# ── Step 3: Node.js ───────────────────────────────────────────────────────────

header "Node.js"

NODE_MIN_MAJOR=22

if has node; then
  NODE_VER="$(node --version)"
  NODE_MAJOR="${NODE_VER#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [[ "$NODE_MAJOR" -ge "$NODE_MIN_MAJOR" ]]; then
    ok "Node.js $NODE_VER (>= v$NODE_MIN_MAJOR required)"
  else
    warn "Node.js $NODE_VER found but v$NODE_MIN_MAJOR+ required"
    if ! $CHECK_ONLY; then
      info "Upgrading Node.js..."
      if [[ "$OS" == "macos" ]]; then
        brew install node@22
        brew link --overwrite node@22 2>/dev/null || true
      else
        # Use NodeSource for Linux
        if has curl; then
          curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
          pkg_install nodejs
        else
          err "curl required to install Node.js"
          exit 1
        fi
      fi
      ok "Node.js upgraded to $(node --version)"
      INSTALLED+=("node")
    fi
  fi
else
  MISSING+=("node")
  if $CHECK_ONLY; then
    warn "Node.js: NOT FOUND"
  else
    info "Installing Node.js v$NODE_MIN_MAJOR..."
    if [[ "$OS" == "macos" ]]; then
      brew install node@22
      brew link --overwrite node@22 2>/dev/null || true
    elif [[ "$DISTRO" == "debian" ]]; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif [[ "$DISTRO" == "fedora" ]]; then
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
      sudo dnf install -y nodejs || sudo yum install -y nodejs
    elif [[ "$DISTRO" == "arch" ]]; then
      sudo pacman -S --noconfirm nodejs npm
    else
      err "Install Node.js v$NODE_MIN_MAJOR+ manually: https://nodejs.org"
      exit 1
    fi
    if has node; then
      ok "Node.js $(node --version) installed"
      INSTALLED+=("node")
    else
      err "Node.js installation failed"
      exit 1
    fi
  fi
fi

# ── Step 4: pnpm ─────────────────────────────────────────────────────────────

header "pnpm"

if has pnpm; then
  ok "pnpm found: $(pnpm --version)"
else
  MISSING+=("pnpm")
  if $CHECK_ONLY; then
    warn "pnpm: NOT FOUND"
  else
    info "Installing pnpm via corepack..."
    if has corepack; then
      corepack enable
      corepack prepare pnpm@latest --activate
    else
      info "corepack not available, installing pnpm via npm..."
      npm install -g pnpm
    fi
    if has pnpm; then
      ok "pnpm $(pnpm --version) installed"
      INSTALLED+=("pnpm")
    else
      err "pnpm installation failed. Install manually: https://pnpm.io/installation"
      exit 1
    fi
  fi
fi

# ── Step 5: Ollama ────────────────────────────────────────────────────────────

header "Ollama"

if has ollama; then
  ok "Ollama found: $(command -v ollama)"
  # Check if Ollama is running
  if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    ok "Ollama server is running"
  else
    warn "Ollama is installed but not running"
    if ! $CHECK_ONLY; then
      info "Starting Ollama..."
      if [[ "$OS" == "macos" ]]; then
        # macOS: Ollama runs as a menu bar app or via brew services
        if brew services list 2>/dev/null | grep -q ollama; then
          brew services start ollama
        else
          open -a Ollama 2>/dev/null || ollama serve &>/dev/null &
        fi
      else
        # Linux: start as background process
        ollama serve &>/dev/null &
      fi
      # Wait up to 10 seconds for it to come up
      for i in $(seq 1 10); do
        if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
          ok "Ollama server started"
          break
        fi
        sleep 1
      done
      if ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
        warn "Ollama started but not yet responding. It may need a moment."
      fi
    fi
  fi
else
  MISSING+=("ollama")
  if $CHECK_ONLY; then
    warn "Ollama: NOT FOUND"
  else
    info "Installing Ollama..."
    if [[ "$OS" == "macos" ]]; then
      brew install ollama
    else
      curl -fsSL https://ollama.com/install.sh | sh
    fi
    if has ollama; then
      ok "Ollama installed"
      INSTALLED+=("ollama")
      # Start the server
      info "Starting Ollama server..."
      if [[ "$OS" == "macos" ]]; then
        brew services start ollama 2>/dev/null || ollama serve &>/dev/null &
      else
        ollama serve &>/dev/null &
      fi
      for i in $(seq 1 10); do
        if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
          ok "Ollama server started"
          break
        fi
        sleep 1
      done
    else
      err "Ollama installation failed. Install manually: https://ollama.com"
    fi
  fi
fi

# ── Step 6: Build ─────────────────────────────────────────────────────────────

if $CHECK_ONLY; then
  header "Summary"
  if [[ ${#MISSING[@]} -eq 0 ]]; then
    ok "All prerequisites are installed"
  else
    warn "Missing: ${MISSING[*]}"
    info "Run without --check to install them"
  fi
  exit 0
fi

# Determine project root (script lives in scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

header "Building LocalClaw"

cd "$PROJECT_ROOT"

info "Installing dependencies (pnpm install)..."
pnpm install

info "Building TypeScript (pnpm build)..."
pnpm build

info "Building UI (pnpm ui:build)..."
pnpm ui:build || warn "UI build skipped (may not be configured)"

# ── Done ──────────────────────────────────────────────────────────────────────

header "Setup Complete"

if [[ ${#INSTALLED[@]} -gt 0 ]]; then
  ok "Newly installed: ${INSTALLED[*]}"
fi

ok "LocalClaw is built and ready"
info ""
info "Next steps:"
info "  1. Run onboarding:  pnpm localclaw onboard"
info "  2. Start gateway:   pnpm localclaw gateway run --bind loopback --port 18790 --force"
info "  3. Start TUI:       pnpm localclaw tui"
info ""
