# Connect AIVS to platform APIs: asks for each key or token (typing is hidden), and writes them into .env.
# Nothing is shown on screen or sent anywhere. A copy of the old .env is kept as .env.before-keys.
# Leave an answer empty to keep the current value. Run it from set-api-keys.bat.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path ".env")) { Write-Host ".env not found. Run start-windows.bat once first."; exit 1 }

$groups = @(
  @{ name = "YouTube (free key; live watchlists, full video details)"; keys = @(@{ k = "YOUTUBE_API_KEY"; secret = $true; help = "Google Cloud Console > APIs and Services > YouTube Data API v3 > Credentials > API key" }) },
  @{ name = "X / Twitter (paid per post read)"; keys = @(@{ k = "X_BEARER_TOKEN"; secret = $true; help = "developer.x.com > your project > app > Keys and tokens > Bearer Token" }) },
  @{ name = "Facebook (Pages you manage, or Page Public Content Access)"; keys = @(
      @{ k = "FACEBOOK_ACCESS_TOKEN"; secret = $true; help = "Graph API Explorer > your app > Get Page Access Token (then extend it in the Access Token Debugger)" },
      @{ k = "FACEBOOK_PAGES"; secret = $false; help = "Page usernames or IDs to watch, separated by commas (for example: yourpage, 1234567890)" }) },
  @{ name = "Meta oEmbed (author and short text of public Facebook/Instagram posts)"; keys = @(@{ k = "META_OEMBED_TOKEN"; secret = $true; help = "APPID|CLIENTTOKEN of a Meta app with the oEmbed Read feature" }) },
  @{ name = "Instagram (your professional account; hashtag search)"; keys = @(
      @{ k = "INSTAGRAM_ACCESS_TOKEN"; secret = $true; help = "Long-lived token of a Meta app with instagram_basic, linked to your Instagram professional account" },
      @{ k = "INSTAGRAM_USER_ID"; secret = $false; help = "The Instagram professional account ID (numbers)" }) },
  @{ name = "Telegram (public channels; free bot)"; keys = @(
      @{ k = "TELEGRAM_BOT_TOKEN"; secret = $true; help = "Talk to @BotFather in Telegram, send /newbot, copy the token. Add the bot to the channels you are allowed to watch." },
      @{ k = "TELEGRAM_OWN_CHANNELS"; secret = $false; help = "Private channels that are your own, separated by commas (leave empty if none)" }) },
  @{ name = "Reddit (free script app)"; keys = @(
      @{ k = "REDDIT_CLIENT_ID"; secret = $false; help = "reddit.com/prefs/apps > create app > type: script > the ID under the app name" },
      @{ k = "REDDIT_CLIENT_SECRET"; secret = $true; help = "The secret shown for that app" },
      @{ k = "REDDIT_USERNAME"; secret = $false; help = "Your Reddit user name (Reddit asks for it in the user agent)" }) },
  @{ name = "Bluesky (free app password)"; keys = @(
      @{ k = "BLUESKY_HANDLE"; secret = $false; help = "Your handle, for example name.bsky.social" },
      @{ k = "BLUESKY_APP_PASSWORD"; secret = $true; help = "Bluesky > Settings > Privacy and security > App passwords > Add" }) },
  @{ name = "Mastodon (no key: public instances to search)"; keys = @(@{ k = "MASTODON_INSTANCES"; secret = $false; help = "Instances separated by commas, for example mastodon.social, mastodon.africa" }) },
  @{ name = "News websites (RSS/Atom feeds, no key)"; keys = @(@{ k = "RSS_FEEDS"; secret = $false; help = "Feed addresses separated by commas" }) },
  @{ name = "TikTok Research API (approved researchers only)"; keys = @(
      @{ k = "TIKTOK_CLIENT_KEY"; secret = $false; help = "From an approved TikTok Research API application" },
      @{ k = "TIKTOK_CLIENT_SECRET"; secret = $true; help = "The client secret of that application" }) },
  @{ name = "Evidence search (Google Fact Check, Brave)"; keys = @(
      @{ k = "GOOGLE_FACTCHECK_API_KEY"; secret = $true; help = "Google Cloud Console > Fact Check Tools API > Credentials > API key" },
      @{ k = "BRAVE_SEARCH_API_KEY"; secret = $true; help = "api.search.brave.com > subscription > API key (paid plans)" }) }
)

$lines = [System.Collections.Generic.List[string]](Get-Content ".env")
function Get-Current($k) { foreach ($l in $lines) { if ($l -match "^\s*$k\s*=\s*(.*)$") { return $Matches[1].Trim() } }; return "" }

Write-Host ""; Write-Host "Which APIs do you want to connect? Status shows only whether a value is already saved; values are never shown."
for ($i = 0; $i -lt $groups.Count; $i++) {
  $set = @($groups[$i].keys | Where-Object { (Get-Current $_.k) -ne "" }).Count
  Write-Host ("  {0,2}. {1}  [{2} of {3} set]" -f ($i + 1), $groups[$i].name, $set, $groups[$i].keys.Count)
}
$pick = Read-Host "Type the numbers separated by commas (for example 1,3,6), or 'all'"
$chosen = if ($pick.Trim() -eq "all") { 0..($groups.Count - 1) } else { $pick -split "[,\s]+" | Where-Object { $_ -match "^\d+$" } | ForEach-Object { [int]$_ - 1 } | Where-Object { $_ -ge 0 -and $_ -lt $groups.Count } }
if (-not $chosen) { Write-Host "Nothing chosen. .env was not changed."; exit 0 }

$changes = @{}
foreach ($g in $chosen) {
  Write-Host ""; Write-Host ("--- " + $groups[$g].name)
  foreach ($e in $groups[$g].keys) {
    $cur = Get-Current $e.k
    Write-Host ("  " + $e.k + ": " + $(if ($cur -ne "") { "already set" } else { "not set" }))
    Write-Host ("    Where to get it: " + $e.help)
    if ($e.secret -and -not [Console]::IsInputRedirected) {
      $s = Read-Host ("    Paste the value (hidden; Enter to keep)") -AsSecureString
      $v = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    } else { $v = Read-Host ("    Value (Enter to keep)") }
    $v = ($v -replace "[\r\n]", "").Trim().Trim('"').Trim("'")
    if ($v -ne "") { $changes[$e.k] = $v }
  }
}
if ($changes.Count -eq 0) { Write-Host ""; Write-Host "No new values. .env was not changed."; exit 0 }
Copy-Item ".env" ".env.before-keys" -Force
$out = [System.Collections.Generic.List[string]]::new()
foreach ($l in $lines) { $skip = $false; foreach ($k in $changes.Keys) { if ($l -match "^\s*$k\s*=") { $skip = $true } }; if (-not $skip) { $out.Add($l) } }
foreach ($k in $changes.Keys) { $out.Add("$k=$($changes[$k])") }
[IO.File]::WriteAllLines((Join-Path (Get-Location) ".env"), [string[]]$out)
Write-Host ""; Write-Host ("Saved " + $changes.Count + " setting(s): " + (($changes.Keys | Sort-Object) -join ", ") + ". Values not shown. The old file is .env.before-keys.")
Write-Host "Next: close the AIVS window, run start-windows.bat (or start-for-reviewers.bat) again, then open"
Write-Host "AI Watchlist > Sources and status and press 'Test connection' for each platform."
