$bytes = [System.IO.File]::ReadAllBytes("C:\Program Files\WindowsApps\Claude_1.6608.2.0_x64__pzs8sxrjxfjjc\app\resources\app.asar")
$text = [System.Text.Encoding]::ASCII.GetString($bytes)

# Find any host that looks like an update/download server
$patterns = @(
    'https://[A-Za-z0-9.\-]*(?:update|download|release|cdn|dist)[A-Za-z0-9.\-]*\.[a-z]{2,}[A-Za-z0-9./_\-]*',
    'https://[a-z0-9\-]+\.(?:anthropic|claude)\.[a-z]{2,}[A-Za-z0-9./_\-]*'
)
foreach ($p in $patterns) {
    Write-Output ("=== " + $p + " ===")
    [regex]::Matches($text, $p) | ForEach-Object { $_.Value } | Sort-Object -Unique | Select-Object -First 30
}

# Find the assignment that fills setFeedURL — look for Wnt = ...
Write-Output "=== Wnt context ==="
$idx = $text.IndexOf("setFeedURL({url:Wnt()")
if ($idx -gt 0) {
    $start = [Math]::Max(0, $idx - 600)
    $len   = [Math]::Min($text.Length - $start, 1200)
    Write-Output $text.Substring($start, $len)
}

# look for "Wnt=function" or "function Wnt"
Write-Output "=== Wnt() definition (first 3 matches) ==="
$rx = [regex]::Matches($text, 'Wnt[ =:][^{]{0,80}\{[^}]{0,400}\}')
$rx | Select-Object -First 3 | ForEach-Object { $_.Value }
