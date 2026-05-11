$ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$url = "https://claude.ai/api/desktop/win32/x64/setup/latest/redirect"

# Step 1: HEAD with no auto-redirect to see where it points
$req = [System.Net.HttpWebRequest]::Create($url)
$req.UserAgent = $ua
$req.AllowAutoRedirect = $false
$req.Method = "GET"
$req.Timeout = 20000
try {
    $resp = $req.GetResponse()
    Write-Output ("Status: " + [int]$resp.StatusCode)
    foreach ($k in @("Location","Content-Type","Content-Length","Content-Disposition")) {
        $v = $resp.Headers[$k]; if ($v) { Write-Output ($k + ": " + $v) }
    }
    $resp.Close()
} catch [System.Net.WebException] {
    $r = $_.Exception.Response
    if ($r) {
        Write-Output ("Status: " + [int]$r.StatusCode)
        foreach ($k in @("Location","Content-Type","Content-Length","Content-Disposition")) {
            $v = $r.Headers[$k]; if ($v) { Write-Output ($k + ": " + $v) }
        }
        $r.Close()
    } else { Write-Output ("err: " + $_.Exception.Message) }
}
