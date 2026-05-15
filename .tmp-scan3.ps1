$bytes = [System.IO.File]::ReadAllBytes("C:\Program Files\WindowsApps\Claude_1.6608.2.0_x64__pzs8sxrjxfjjc\app\resources\app.asar")
$text = [System.Text.Encoding]::ASCII.GetString($bytes)

Write-Output "=== context around 'darwin/universal' ==="
$idx = $text.IndexOf("darwin/universal")
if ($idx -gt 0) {
    $start = [Math]::Max(0, $idx - 800)
    $len   = [Math]::Min($text.Length - $start, 1800)
    Write-Output $text.Substring($start, $len)
}

Write-Output ""
Write-Output "=== first 10 occurrences of 'releases/' ==="
$rx = [regex]::Matches($text, '[A-Za-z0-9.:_/\-]{0,80}releases/[A-Za-z0-9.:_/\-${}\(\) +`]{0,140}')
$rx | Select-Object -First 10 | ForEach-Object { $_.Value }
