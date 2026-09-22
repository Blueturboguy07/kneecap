# bugfix-lab oracle recipe for kneecap-android-gradle-download-timeout
#
# Reproduces, on a Windows runner, the guide's "open the android folder in Android
# Studio" step's Gradle sync — specifically the part where Gradle's wrapper bootstrap
# downloads the pinned distribution from services.gradle.org. Android Studio itself
# isn't scriptable in CI; the wrapper bootstrap it triggers under the hood IS this
# exact download, and it runs before any Android SDK/project-specific setup, so it is
# a faithful stand-in for the guide step's failure mode.
#
# We do not fabricate the failure by editing gradle-wrapper.properties or grepping
# source for a patch — that would be a tautology. Instead we constrain the network the
# same way a restrictive/slow home network would: a hosts-file redirect of
# services.gradle.org to a reserved, non-routable IP (RFC 5737 TEST-NET), so the TCP
# SYN genuinely leaves this host and gets silently dropped somewhere upstream — no
# response ever comes back, which is what a real OS/JVM connect-timeout requires.
# (A local Windows Firewall Block rule was tried first and rejected: WFP denies the
# socket synchronously, before any packet leaves the host, so Java sees an immediate
# "java.net.SocketException: Permission denied: getsockopt" in ~1s — a different
# exception class than the reporter's SocketTimeoutException. See log.md attempt 1.)
#
# Exit contract: 1 = bug PRESENT (sync attempted, hit a connect-timeout downloading the
# distribution). 0 = bug ABSENT (sync's distribution download succeeded). 2 = oracle
# could not run (e.g. couldn't resolve the host, couldn't install a JDK).

$ErrorActionPreference = "Stop"
$repoRoot = git rev-parse --show-toplevel
$androidDir = Join-Path $repoRoot "apps\mobile\android"
$wrapperProps = Join-Path $androidDir "gradle\wrapper\gradle-wrapper.properties"

if (-not (Test-Path $wrapperProps)) {
  Write-Host "BUGFIX_LAB_ABSENT (oracle could not run: no gradle-wrapper.properties at $wrapperProps)"
  exit 2
}

$distLine = Select-String -Path $wrapperProps -Pattern "^distributionUrl=" | Select-Object -First 1
Write-Host "Pinned wrapper distributionUrl: $($distLine.Line)"

# --- Constrain the network path to services.gradle.org (silent drop, not reject) ---
$targetHost = "services.gradle.org"
$blackhole = "192.0.2.1"   # RFC 5737 TEST-NET-1: reserved, never assigned to a real host.
$hostsFile = "$env:windir\System32\drivers\etc\hosts"
try {
  Add-Content -Path $hostsFile -Value "`n$blackhole`t$targetHost`t# bugfix-lab blackhole" -ErrorAction Stop
} catch {
  Write-Host "BUGFIX_LAB_ABSENT (oracle could not run: could not write hosts file: $_)"
  exit 2
}
Write-Host "Redirected $targetHost -> $blackhole via hosts file"
Write-Host (Resolve-DnsName -Name $targetHost -Type A | Out-String)

# --- Force a real download attempt: fresh GRADLE_USER_HOME so nothing is cached ---
$freshHome = Join-Path $env:RUNNER_TEMP "gradle-home-fresh"
New-Item -ItemType Directory -Force -Path $freshHome | Out-Null
$env:GRADLE_USER_HOME = $freshHome

Push-Location $androidDir
$logFile = Join-Path $env:RUNNER_TEMP "gradle-sync-attempt.log"
Write-Host "Running gradlew.bat (this is what Android Studio's 'Gradle sync' invokes under the hood)..."

$proc = Start-Process -FilePath ".\gradlew.bat" -ArgumentList "--version" `
  -NoNewWindow -PassThru -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
$finished = $proc.WaitForExit(120000)  # 2 minutes: individual connect attempts are capped at
                                        # the wrapper's own networkTimeout (10s); this is a
                                        # generous outer bound, not the thing under test.
if (-not $finished) {
  Write-Host "gradlew.bat did not exit within 120s; killing it."
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
Pop-Location

$output = ""
if (Test-Path $logFile) { $output += Get-Content $logFile -Raw }
if (Test-Path "$logFile.err") { $output += "`n" + (Get-Content "$logFile.err" -Raw) }
Write-Host "----- gradlew.bat output -----"
Write-Host $output
Write-Host "----- end output -----"

# --- Clean up the hosts file redirect regardless of outcome ---
(Get-Content $hostsFile) | Where-Object { $_ -notmatch "# bugfix-lab blackhole" } | Set-Content $hostsFile

$hitTimeout = $output -match "SocketTimeoutException" -and $output -match "Connect timed out"
$hitInstallFailure = $output -match "Could not install Gradle distribution"
$hitDomain = $output -match [regex]::Escape($targetHost)

if ($hitTimeout -and $hitInstallFailure -and $hitDomain) {
  Write-Host "BUGFIX_LAB_PRESENT"
  Write-Host "Evidence: gradlew.bat's distribution download hit java.net.SocketTimeoutException: Connect timed out reaching $targetHost, matching the reporter's exception class (their pasted URL names gradle-8.7-bin.zip; this pin's wrapper names $($distLine.Line) — that version-number mismatch is real and is called out in RESULT.json, but the failure MECHANISM — a connect-phase timeout downloading the wrapper's pinned distribution from services.gradle.org — is the same)."
  exit 1
} elseif (-not $finished) {
  Write-Host "BUGFIX_LAB_PRESENT"
  Write-Host "Evidence: gradlew.bat hung past the 120s outer bound trying to reach $targetHost and had to be killed — consistent with a connect-phase stall, though the process did not print the exception text before being killed."
  exit 1
} else {
  Write-Host "BUGFIX_LAB_ABSENT"
  Write-Host "Evidence: gradlew.bat's distribution download did not hit a connect-timeout against the blocked path to $targetHost."
  exit 0
}
