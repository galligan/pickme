#!/bin/bash
# pickme installer
# Usage: curl -fsSL https://raw.githubusercontent.com/galligan/pickme/main/install.sh | bash

set -e

REPO="galligan/pickme"
INSTALL_DIR="${HOME}/.local/bin"
DATA_DIR="${HOME}/.local/share/pickme"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
DIM='\033[2m'
RESET='\033[0m'

info() { echo -e "${GREEN}▸${RESET} $1"; }
warn() { echo -e "${YELLOW}▸${RESET} $1"; }
error() { echo -e "${RED}▸${RESET} $1" >&2; exit 1; }

# Detect platform
detect_platform() {
  local os arch

  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) error "Unsupported operating system: $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "Unsupported architecture: $(uname -m)" ;;
  esac

  echo "${os}-${arch}"
}

# Get latest release version
get_latest_version() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | \
    grep '"tag_name"' | \
    sed -E 's/.*"v?([^"]+)".*/\1/'
}

# Download and install binary
install_binary() {
  local platform="$1"
  local version="$2"
  local asset_name="pickme-${platform}.tar.gz"
  local download_url="https://github.com/${REPO}/releases/download/v${version}/${asset_name}"
  local tmp_dir

  tmp_dir=$(mktemp -d)
  trap "rm -rf ${tmp_dir}" EXIT

  info "Downloading pickme v${version} for ${platform}..."
  curl -fsSL "${download_url}" -o "${tmp_dir}/${asset_name}" || \
    error "Failed to download from ${download_url}"

  info "Extracting..."
  tar -xzf "${tmp_dir}/${asset_name}" -C "${tmp_dir}"

  # Create install directory
  mkdir -p "${INSTALL_DIR}"

  # Install binary
  mv "${tmp_dir}/pickme-${platform}" "${INSTALL_DIR}/pickme"
  chmod +x "${INSTALL_DIR}/pickme"

  info "Installed pickme to ${INSTALL_DIR}/pickme"
}

# Set up plugin directory
setup_plugin() {
  local version="$1"
  local plugin_dir="${DATA_DIR}/plugin"

  info "Setting up Claude plugin..."

  mkdir -p "${plugin_dir}/.claude-plugin"
  mkdir -p "${plugin_dir}/hooks"
  mkdir -p "${plugin_dir}/scripts"

  # Write plugin.json
  cat > "${plugin_dir}/.claude-plugin/plugin.json" << 'EOF'
{
  "name": "pickme",
  "version": "VERSION_PLACEHOLDER",
  "description": "Ultrafast @file suggester with background index refresh",
  "author": {
    "name": "Matt Galligan",
    "url": "https://github.com/galligan"
  }
}
EOF
  sed -i.bak "s/VERSION_PLACEHOLDER/${version}/" "${plugin_dir}/.claude-plugin/plugin.json"
  rm -f "${plugin_dir}/.claude-plugin/plugin.json.bak"

  # Write hooks.json
  cat > "${plugin_dir}/hooks/hooks.json" << 'EOF'
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
EOF

  # Write marketplace.json
  mkdir -p "${DATA_DIR}/.claude-plugin"
  cat > "${DATA_DIR}/.claude-plugin/marketplace.json" << 'EOF'
{
  "name": "pickme-cli",
  "owner": {
    "name": "Matt Galligan",
    "email": "noreply@pickme.local"
  },
  "plugins": [
    {
      "name": "pickme",
      "source": "./plugin",
      "description": "Ultrafast @file suggester with background index refresh",
      "version": "VERSION_PLACEHOLDER",
      "author": {
        "name": "Matt Galligan",
        "url": "https://github.com/galligan"
      }
    }
  ]
}
EOF
  sed -i.bak "s/VERSION_PLACEHOLDER/${version}/" "${DATA_DIR}/.claude-plugin/marketplace.json"
  rm -f "${DATA_DIR}/.claude-plugin/marketplace.json.bak"

  # Write session-start.sh
  cat > "${plugin_dir}/scripts/session-start.sh" << 'EOF'
#!/bin/bash
# pickme SessionStart hook
# Refreshes file indexes in the background to keep @file suggestions fast

# Check standard install location first
PICKME_BIN="${HOME}/.local/bin/pickme"

# Fallback to PATH
if [[ ! -x "$PICKME_BIN" ]]; then
  PICKME_BIN="$(command -v pickme 2>/dev/null || true)"
fi

# Exit silently if pickme not found
[[ -z "$PICKME_BIN" || ! -x "$PICKME_BIN" ]] && exit 0

# Run refresh in background
nohup "$PICKME_BIN" refresh >/dev/null 2>&1 &

exit 0
EOF
  chmod +x "${plugin_dir}/scripts/session-start.sh"

  info "Plugin installed to ${plugin_dir}"
}

# Check PATH
check_path() {
  if [[ ":${PATH}:" != *":${INSTALL_DIR}:"* ]]; then
    echo ""
    warn "${INSTALL_DIR} is not in your PATH"
    echo ""
    echo -e "${DIM}Add this to your shell config:${RESET}"
    echo ""
    echo "  export PATH=\"\${HOME}/.local/bin:\${PATH}\""
    echo ""
  fi
}

# Main
main() {
  echo ""
  echo -e "${GREEN}pickme installer${RESET}"
  echo -e "${DIM}An ultrafast @file suggester for Claude${RESET}"
  echo ""

  local platform version

  platform=$(detect_platform)
  info "Detected platform: ${platform}"

  version=$(get_latest_version)
  if [[ -z "${version}" ]]; then
    error "Could not determine latest version"
  fi
  info "Latest version: v${version}"

  install_binary "${platform}" "${version}"
  setup_plugin "${version}"
  check_path

  echo ""
  info "Installation complete!"
  echo ""
  echo -e "${DIM}To complete setup, run:${RESET}"
  echo ""
  echo "  pickme init"
  echo ""
}

main "$@"
