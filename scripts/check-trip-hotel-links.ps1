# Read-only live smoke for every Trip.com hotel hand-off configured in destinations.ts.
# Usage from the repository root:
#   pwsh -File etl/scripts/check-trip-hotel-links.ps1
[CmdletBinding()]
param(
  [string]$CheckIn = (Get-Date).ToUniversalTime().AddDays(30).ToString('yyyy-MM-dd'),
  [string]$CheckOut = (Get-Date).ToUniversalTime().AddDays(33).ToString('yyyy-MM-dd'),
  [int]$ThrottleLimit = 4
)

$source = Get-Content 'src/data/destinations.ts' -Raw
$matches = [regex]::Matches($source, "id:\s*'([^']+)'[\s\S]*?city:\s*'([^']+)'[\s\S]*?iata:\s*'([^']+)'[\s\S]*?tripCityId:\s*(\d+)")
$rows = foreach ($match in $matches) {
  [pscustomobject]@{
    Id = $match.Groups[1].Value
    City = $match.Groups[2].Value
    Iata = $match.Groups[3].Value
    TripCityId = [int]$match.Groups[4].Value
  }
}
if ($rows.Count -eq 0) { throw 'No destinations with tripCityId parsed' }

$results = $rows | ForEach-Object -Parallel {
  $row = $_
  $url = "https://www.trip.com/hotels/list?city=$($row.TripCityId)&checkin=$($using:CheckIn)&checkout=$($using:CheckOut)&adult=1&children=0&crn=1&curr=EUR"
  try {
    $response = Invoke-WebRequest -Uri $url -MaximumRedirection 8 -TimeoutSec 35 -UseBasicParsing
    $body = $response.Content
    $hardError = $body -match '(?i)page\s+not\s+found|destination\s+does\s+not\s+exist|invalid\s+city|city\s+not\s+found'
    $blocked = $body -match '(?i)captcha|verify\s+you(?:''re|\s+are)\s+human|access\s+denied'
    $cityNeedle = $row.City.Split(' (')[0]
    [pscustomobject]@{
      Iata = $row.Iata; City = $row.City; TripCityId = $row.TripCityId
      Status = [int]$response.StatusCode
      FinalUrl = $response.BaseResponse.RequestMessage.RequestUri.AbsoluteUri
      Bytes = $body.Length
      CityVisible = $body.Contains($cityNeedle)
      HardError = $hardError; Blocked = $blocked
      Ok = ($response.StatusCode -eq 200 -and -not $hardError -and -not $blocked)
      Error = ''
    }
  } catch {
    [pscustomobject]@{
      Iata = $row.Iata; City = $row.City; TripCityId = $row.TripCityId
      Status = 0; FinalUrl = ''; Bytes = 0; CityVisible = $false
      HardError = $false; Blocked = $false; Ok = $false
      Error = $_.Exception.Message
    }
  }
} -ThrottleLimit $ThrottleLimit

$failed = @($results | Where-Object { -not $_.Ok })
$suspicious = @($results | Where-Object { $_.Ok -and -not $_.CityVisible })
[pscustomobject]@{
  CheckedAt = (Get-Date).ToString('o')
  CheckIn = $CheckIn; CheckOut = $CheckOut
  Configured = $rows.Count; Checked = $results.Count
  Ok = $results.Count - $failed.Count; Failed = $failed.Count
  SuspiciousWithoutCityName = $suspicious.Count
  Failures = $failed; Suspicious = $suspicious
} | ConvertTo-Json -Depth 5
