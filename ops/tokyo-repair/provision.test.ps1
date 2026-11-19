#Requires -Version 7.0
# No network or external writes: all gcloud calls are replaced with metadata fixtures.
$ErrorActionPreference = 'Stop'
$global:tokyoRepairProbeCalls = [Collections.Generic.List[string]]::new()
$global:tokyoRepairProbeMode = 'normal'
$global:tokyoRepairProbeRoles = @{
  harakaTokyoRepairBuildSubmit=@('cloudbuild.builds.create','cloudbuild.builds.get','cloudbuild.operations.get')
  harakaTokyoRepairRunOperationRead=@('run.operations.get')
  harakaTokyoRepairJobUpdate=@('run.jobs.get','run.jobs.update','run.jobs.run','run.jobs.runWithOverrides','run.executions.get','run.executions.list')
  harakaTokyoRepairJobInvoke=@('run.jobs.get','run.jobs.run','run.executions.get','run.executions.list')
  harakaTokyoRepairRepoToken=@('cloudbuild.repositories.get','cloudbuild.repositories.list','cloudbuild.repositories.accessReadWriteToken')
  harakaTokyoRepairObjectRead=@('storage.objects.get')
  harakaTokyoRepairModelMetadata=@('secretmanager.versions.get')
}
function global:gcloud {
  $words = @($args)
  $line = $words -join ' '
  $global:tokyoRepairProbeCalls.Add($line)
  $global:LASTEXITCODE = 0
  if ($line -match '\b(create|update|deploy|resume|pause|add-iam-policy-binding|access|submit|enable)\b') { throw "Unexpected external mutation: $line" }
  $data = switch -Regex ($line) {
    '^projects describe ' { @{projectNumber='569936489397'}; break }
    '^services list ' { @('run','cloudbuild','cloudscheduler','secretmanager','artifactregistry','storage','iam') | ForEach-Object { @{config=@{name="$_.googleapis.com"}} }; break }
    '^iam service-accounts describe ' { @{disabled=$false}; break }
    '^storage buckets describe ' { @{projectNumber='569936489397'; location='ASIA-NORTHEAST1'; iamConfiguration=@{uniformBucketLevelAccess=@{enabled=$true};publicAccessPrevention='enforced'}}; break }
    '^builds connections describe ' { @{installationState=@{stage='COMPLETE'};githubConfig=@{appInstallationId='116076180';authorizerCredential=@{oauthTokenSecretVersion='projects/spectre-tomstocks-20260227/secrets/haraka-github-github-oauthtoken-fc9ec6/versions/latest'}}}; break }
    '^builds repositories list ' {
      $name='projects/spectre-tomstocks-20260227/locations/asia-northeast1/connections/haraka-tokyo-repair-github/repositories/harakafor-manman'
      @(@{name=$name;remoteUri='https://github.com/nagatar-hub/HarakaforMANMAN.git'})
      if ($global:tokyoRepairProbeMode -eq 'unexpectedRepo') { @{name=$name+'-other'; remoteUri='https://github.com/nagatar-hub/another.git'} }
      break
    }
    '^secrets describe ' { @{name=$words[2]}; break }
    '^logging views describe ' { @{filter='resource.type="cloud_run_job" AND resource.labels.project_id="spectre-tomstocks-20260227" AND resource.labels.job_name=~"^haraka-manman-akihabara-(sync|generate|watchdog)$"'}; break }
    '^iam roles describe ' {
      $permissions=$global:tokyoRepairProbeRoles[$words[3]]
      if (!$permissions) { throw 'Unexpected role fixture.' }
      if ($global:tokyoRepairProbeMode -eq 'changedRole') { $permissions+= 'storage.objects.delete' }
      @{includedPermissions=$permissions;deleted=$false}; break
    }
    ' get-iam-policy ' {
      if ($global:tokyoRepairProbeMode -eq 'broadWorker' -and $words[0] -eq 'projects') {
        @{bindings=@(@{role='roles/editor';members=@('serviceAccount:haraka-tokyo-repair-build@spectre-tomstocks-20260227.iam.gserviceaccount.com')})}
      } elseif ($words[0] -eq 'secrets' -and $words[2] -eq 'haraka-tokyo-repair-openai-api-key') {
        $role=if ($global:tokyoRepairProbeMode -eq 'modelPayload') { 'roles/secretmanager.secretAccessor' } else { 'projects/spectre-tomstocks-20260227/roles/harakaTokyoRepairModelMetadata' }
        @{bindings=@(@{role=$role;members=@('serviceAccount:haraka-tokyo-repair-ctl@spectre-tomstocks-20260227.iam.gserviceaccount.com')})}
      } else { @{bindings=@()} }
      break
    }
    default { throw "Unexpected read command: $line" }
  }
  ConvertTo-Json -InputObject $data -Depth 20 -Compress
}
function Assert-Fails([string]$Mode,[string]$Expected,[hashtable]$Parameters=@{}) {
  $global:tokyoRepairProbeMode=$Mode
  try { & "$PSScriptRoot/provision.ps1" @Parameters 6>$null; throw 'Expected rejection did not occur.' }
  catch { if ($_.Exception.Message -notmatch $Expected) { throw } }
}
try {
  $contract = (& "$PSScriptRoot/provision.ps1" -PrintContract | ConvertFrom-Json)
  if ($global:tokyoRepairProbeCalls.Count -ne 0 -or $contract.workerServiceAccount -eq $contract.controllerServiceAccount) { throw 'Contract should be offline and isolate worker identity.' }
  & "$PSScriptRoot/provision.ps1" 6>$null
  if (!$global:tokyoRepairProbeCalls.Count) { throw 'Read-only plan did not inspect metadata.' }
  Assert-Fails 'unexpectedRepo' 'unexpected repository'
  Assert-Fails 'changedRole' 'differs'
  Assert-Fails 'normal' 'require -Apply' @{DeployController=$true}
  Assert-Fails 'normal' 'immutable sha256' @{Apply=$true;DeployController=$true;ControllerImage='bad:latest'}
  Assert-Fails 'broadWorker' 'Unexpected project-level grant' @{Readback=$true}
  Assert-Fails 'modelPayload' 'metadata only' @{Readback=$true}
  $global:tokyoRepairProbeMode='normal'
  & "$PSScriptRoot/provision.ps1" -Readback 6>$null | Out-Null
  Write-Output 'PASS: 9 provisioning checks (offline contract, read-only default, unrelated repository, role drift, apply gate, digest gate, worker overprivilege, model payload denial, metadata-only grant).'
} finally { Remove-Item Function:\gcloud }
