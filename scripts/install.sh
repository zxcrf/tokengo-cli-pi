#!/usr/bin/env bash
#
# Install the tokengo CLI (macOS / Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/zxcrf/tokengo-cli/main/scripts/install.sh | bash
#
# Environment:
#   TOKENGO_VERSION          Version to install, with or without leading "v" (default: latest release)
#   TOKENGO_INSTALL_DIR      Install root (default: $HOME/.tokengo)
#   TOKENGO_INSTALL_ARCHIVE  Local tokengo-<platform>.tar.gz to install instead of downloading.
#                            A SHA256SUMS file next to it is verified when present.
#   TOKENGO_REPO             GitHub repository (default: zxcrf/tokengo-cli)
#   GITHUB_TOKEN             Optional token for GitHub API / download rate limits
#
# Layout: <root>/bin/<version>/tokengo/tokengo, with <root>/bin/tokengo symlinked to it.

set -euo pipefail

REPO="${TOKENGO_REPO:-zxcrf/tokengo-cli}"
INSTALL_ROOT="${TOKENGO_INSTALL_DIR:-$HOME/.tokengo}"
# The symlink target must stay valid from any working directory.
case "$INSTALL_ROOT" in
    /*) ;;
    *) INSTALL_ROOT="$PWD/${INSTALL_ROOT#./}" ;;
esac
BIN_ROOT="$INSTALL_ROOT/bin"

info() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v curl >/dev/null 2>&1 || [[ -n "${TOKENGO_INSTALL_ARCHIVE:-}" ]] || fail "curl is required"

detect_platform() {
    local os arch
    case "$(uname -s)" in
        Darwin) os="darwin" ;;
        Linux) os="linux" ;;
        *) fail "unsupported operating system: $(uname -s). On Windows use install.ps1" ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64) arch="x64" ;;
        arm64|aarch64) arch="arm64" ;;
        *) fail "unsupported architecture: $(uname -m)" ;;
    esac
    # An x64 shell running under Rosetta should still get the native arm64 build.
    if [[ "$os" == "darwin" && "$arch" == "x64" ]] && [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" == "1" ]]; then
        arch="arm64"
    fi
    printf '%s-%s' "$os" "$arch"
}

curl_github() {
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then
        curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$@"
    else
        curl -fsSL "$@"
    fi
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        fail "sha256sum or shasum is required to verify the download"
    fi
}

verify_checksum() {
    local archive="$1" sums="$2" name expected actual
    name="$(basename "$archive")"
    expected="$(awk -v n="$name" '{f=$2; sub(/^\*/, "", f); if (f == n) {print $1; exit}}' "$sums")"
    [[ -n "$expected" ]] || fail "SHA256SUMS has no entry for $name"
    actual="$(sha256_of "$archive")"
    [[ "$expected" == "$actual" ]] || fail "checksum mismatch for $name (expected $expected, got $actual)"
    info "Checksum OK ($name)"
}

PLATFORM="$(detect_platform)"
ARCHIVE_NAME="tokengo-$PLATFORM.tar.gz"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

VERSION="${TOKENGO_VERSION:-}"
VERSION="${VERSION#v}"

if [[ -n "${TOKENGO_INSTALL_ARCHIVE:-}" ]]; then
    ARCHIVE="$TOKENGO_INSTALL_ARCHIVE"
    [[ -f "$ARCHIVE" ]] || fail "TOKENGO_INSTALL_ARCHIVE not found: $ARCHIVE"
    VERSION="${VERSION:-local}"
    SUMS="$(dirname "$ARCHIVE")/SHA256SUMS"
    if [[ -f "$SUMS" ]]; then
        # The local archive keeps its release name when it comes from a build or release download.
        verify_checksum "$ARCHIVE" "$SUMS"
    else
        info "No SHA256SUMS next to $ARCHIVE; skipping checksum verification"
    fi
else
    if [[ -z "$VERSION" ]]; then
        info "Resolving latest release of $REPO..."
        TAG="$(curl_github -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/latest" \
            | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)" \
            || fail "could not query the latest release of $REPO (no release yet, or GitHub API rate limit; set GITHUB_TOKEN or TOKENGO_VERSION)"
        [[ -n "$TAG" ]] || fail "could not determine the latest release of $REPO"
        VERSION="${TAG#v}"
    fi
    BASE_URL="https://github.com/$REPO/releases/download/v$VERSION"
    ARCHIVE="$TMP_DIR/$ARCHIVE_NAME"
    info "Downloading tokengo $VERSION ($PLATFORM)..."
    curl_github -o "$ARCHIVE" "$BASE_URL/$ARCHIVE_NAME" || fail "could not download $BASE_URL/$ARCHIVE_NAME"
    curl_github -o "$TMP_DIR/SHA256SUMS" "$BASE_URL/SHA256SUMS" || fail "could not download $BASE_URL/SHA256SUMS"
    verify_checksum "$ARCHIVE" "$TMP_DIR/SHA256SUMS"
fi

TARGET_DIR="$BIN_ROOT/$VERSION"
STAGE_DIR="$BIN_ROOT/.install-$$"
mkdir -p "$BIN_ROOT"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
trap 'rm -rf "$TMP_DIR" "$STAGE_DIR"' EXIT

tar -xzf "$ARCHIVE" -C "$STAGE_DIR"
[[ -x "$STAGE_DIR/tokengo/tokengo" ]] || fail "archive does not contain tokengo/tokengo"

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
mv "$STAGE_DIR/tokengo" "$TARGET_DIR/tokengo"
ln -sfn "$TARGET_DIR/tokengo/tokengo" "$BIN_ROOT/tokengo"

info "Installed tokengo $VERSION to $TARGET_DIR/tokengo"
info "Linked $BIN_ROOT/tokengo"

case ":$PATH:" in
    *":$BIN_ROOT:"*) ;;
    *)
        info ""
        info "Add tokengo to your PATH:"
        info "  export PATH=\"$BIN_ROOT:\$PATH\""
        ;;
esac
