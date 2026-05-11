$bytes = [System.IO.File]::ReadAllBytes("C:\Program Files\WindowsApps\Claude_1.6608.2.0_x64__pzs8sxrjxfjjc\app\resources\app.asar")
$text = [System.Text.Encoding]::ASCII.GetString($bytes)

$patterns = @(
    'https://[A-Za-z0-9./_\-]*claude[A-Za-z0-9./_\-]*',
    'https://[A-Za-z0-9./_\-]*anthropic[A-Za-z0-9./_\-]*',
    'https://[A-Za-z0-9./_\-]+\.msix[A-Za-z0-9./_\-]*',
    'https://[A-Za-z0-9./_\-]+\.exe',
    'setFeedURL[^,]{0,120}',
    'updateUrl["'' :]+[A-Za-z0-9./:_\-]+',
    'publishUrl["'' :]+[A-Za-z0-9./:_\-]+'
)

foreach ($p in $patterns) {
    Write-Output ("=== " + $p + " ===")
    [regex]::Matches($text, $p) | ForEach-Object { $_.Value } | Sort-Object -Unique | Select-Object -First 20
}
