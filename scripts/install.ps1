# Install the tokengo CLI (Windows).
#
#   irm https://raw.githubusercontent.com/zxcrf/tokengo-cli/main/scripts/install.ps1 | iex
#
# Environment:
#   TOKENGO_VERSION          Version to install, with or without leading "v" (default: latest release)
#   TOKENGO_INSTALL_DIR      Install root (default: %LOCALAPPDATA%\tokengo)
#   TOKENGO_INSTALL_ARCHIVE  Local tokengo-windows-<arch>.zip to install instead of downloading.
#                            A SHA256SUMS file next to it is verified when present.
#   TOKENGO_REPO             GitHub repository (default: zxcrf/tokengo-cli)
#   GITHUB_TOKEN             Optional token for GitHub API / download rate limits
#
# Layout: <root>\<version>\tokengo.exe, with <root>\current as a junction to the active version.
# <root>\current is added to the user PATH.

function Install-Tokengo {
    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"

    $repo = if ($env:TOKENGO_REPO) { $env:TOKENGO_REPO } else { "zxcrf/tokengo-cli" }
    $root = if ($env:TOKENGO_INSTALL_DIR) { $env:TOKENGO_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "tokengo" }
    $headers = @{ "User-Agent" = "tokengo-install" }
    if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $($env:GITHUB_TOKEN)" }

    # A 32-bit PowerShell on 64-bit Windows reports x86 here and the real architecture below.
    $procArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = switch ($procArch) {
        "AMD64" { "x64" }
        "ARM64" { "arm64" }
        default { throw "Unsupported architecture: $procArch" }
    }
    $archiveName = "tokengo-windows-$arch.zip"

    $version = if ($env:TOKENGO_VERSION) { $env:TOKENGO_VERSION.TrimStart("v") } else { "" }
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("tokengo-install-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp | Out-Null

    try {
        $sumsPath = $null
        if ($env:TOKENGO_INSTALL_ARCHIVE) {
            $archive = $env:TOKENGO_INSTALL_ARCHIVE
            if (-not (Test-Path -LiteralPath $archive)) { throw "TOKENGO_INSTALL_ARCHIVE not found: $archive" }
            if (-not $version) { $version = "local" }
            $localSums = Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $archive)) "SHA256SUMS"
            if (Test-Path -LiteralPath $localSums) { $sumsPath = $localSums }
            else { Write-Host "No SHA256SUMS next to $archive; skipping checksum verification" }
        } else {
            if (-not $version) {
                Write-Host "Resolving latest release of $repo..."
                $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repo/releases/latest"
                $version = ([string]$release.tag_name).TrimStart("v")
                if (-not $version) { throw "Could not determine the latest release of $repo" }
            }
            $baseUrl = "https://github.com/$repo/releases/download/v$version"
            $archive = Join-Path $tmp $archiveName
            $sumsPath = Join-Path $tmp "SHA256SUMS"
            Write-Host "Downloading tokengo $version (windows-$arch)..."
            Invoke-WebRequest -Headers $headers -Uri "$baseUrl/$archiveName" -OutFile $archive
            Invoke-WebRequest -Headers $headers -Uri "$baseUrl/SHA256SUMS" -OutFile $sumsPath
        }

        if ($sumsPath) {
            $name = Split-Path -Leaf $archive
            $line = Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($name))\s*$" } | Select-Object -First 1
            if (-not $line) { throw "SHA256SUMS has no entry for $name" }
            $expected = ($line -split "\s+")[0].ToLowerInvariant()
            $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
            if ($expected -ne $actual) { throw "Checksum mismatch for $name (expected $expected, got $actual)" }
            Write-Host "Checksum OK ($name)"
        }

        $stage = Join-Path $tmp "extracted"
        Expand-Archive -LiteralPath $archive -DestinationPath $stage -Force
        if (-not (Test-Path -LiteralPath (Join-Path $stage "tokengo.exe"))) { throw "Archive does not contain tokengo.exe" }

        $target = Join-Path $root $version
        New-Item -ItemType Directory -Force -Path $root | Out-Null
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        # Copy then delete: Move-Item fails across volumes (the temp dir may be on another drive).
        Copy-Item -LiteralPath $stage -Destination $target -Recurse
        Remove-Item -LiteralPath $stage -Recurse -Force

        $current = Join-Path $root "current"
        if (Test-Path -LiteralPath $current) { [System.IO.Directory]::Delete($current, $false) }
        New-Item -ItemType Junction -Path $current -Target $target | Out-Null

        # Read and write the raw registry value so %VARS% in an existing Path stay unexpanded (REG_EXPAND_SZ).
        $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
        try {
            $userPath = [string]$envKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
            if ($userPath) { $kind = $envKey.GetValueKind("Path") }
            $entries = if ($userPath) { $userPath -split ";" } else { @() }
            if ($entries -notcontains $current) {
                $newPath = (@($entries | Where-Object { $_ }) + $current) -join ";"
                $envKey.SetValue("Path", $newPath, $kind)
                # Setting any user variable broadcasts the environment change to running shells.
                [Environment]::SetEnvironmentVariable("TOKENGO_PATH_REFRESH", $null, "User")
                Write-Host "Added $current to your user PATH. Restart your terminal to use tokengo."
            }
        } finally {
            $envKey.Close()
        }

        Write-Host "Installed tokengo $version to $target"
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Install-Tokengo
