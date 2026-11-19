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
  harakaTokyoRepairImagePull=@('artifactregistry.repositories.downloadArtifacts')
  harakaTokyoRepairSignBlob=@('iam.serviceAccounts.signBlob')
}
function global:gcloud {
  $words = @($args)
  $line = $words -join ' '
  $global:tokyoRepairProbeCalls.Add($line)
  $global:LASTEXITCODE = 0
  if ($global:tokyoRepairProbeMode -in @('missingController','deniedController')) {
    if ($line -match '^run jobs describe haraka-tokyo-repair ') {
      $reason=if ($global:tokyoRepairProbeMode -eq 'missingController') { 'ERROR: (gcloud.run.jobs.describe) Cannot find job [haraka-tokyo-repair].' } else { 'ERROR: (gcloud.run.jobs.describe) PERMISSION_DENIED: missing run.jobs.get.' }
      Write-Error $reason -ErrorAction Continue
      $global:LASTEXITCODE=1;return
    }
    if ($line -match '^scheduler jobs describe ') {
      Write-Error 'ERROR: NOT_FOUND: Job not found.' -ErrorAction Continue
      $global:LASTEXITCODE=1;return
    }
    if ($line -match ' add-iam-policy-binding |^run jobs deploy |^scheduler jobs (create|pause|update) ') { '{}';return }
  }
  if ($line -match '\b(create|update|deploy|resume|pause|add-iam-policy-binding|access|submit|enable)\b') { throw "Unexpected external mutation: $line" }
  $data = switch -Regex ($line) {
    '^projects describe ' { @{projectNumber='569936489397'}; break }
    '^services list ' { @('run','cloudbuild','cloudscheduler','secretmanager','artifactregistry','storage','iam','iamcredentials') | ForEach-Object { @{config=@{name="$_.googleapis.com"}} }; break }
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
    '^artifacts repositories describe ' { @{format='DOCKER';mode='STANDARD_REPOSITORY'}; break }
    '^artifacts docker images describe ' { @{image_summary=@{digest=$(if($global:tokyoRepairProbeMode -eq 'mirrorMismatch') {'sha256:'+('1'*64)} else {($words[4] -split '@')[1]})}}; break }
    '^logging views describe ' { @{filter='resource.type="cloud_run_job" AND resource.labels.project_id="spectre-tomstocks-20260227" AND resource.labels.job_name=~"^haraka-manman-akihabara-(sync|generate|watchdog)$"'}; break }
    '^iam roles describe ' {
      $permissions=$global:tokyoRepairProbeRoles[$words[3]]
      if (!$permissions) { throw 'Unexpected role fixture.' }
      if ($global:tokyoRepairProbeMode -eq 'changedRole') { $permissions+= 'storage.objects.delete' }
      @{includedPermissions=$permissions;deleted=$false}; break
    }
    ' get-iam-policy ' {
      if ($words[0] -eq 'iam' -and $words[1] -eq 'service-accounts' -and $words[3] -eq 'haraka-tokyo-repair-ctl@spectre-tomstocks-20260227.iam.gserviceaccount.com' -and $global:tokyoRepairProbeMode -in @('extraSigner','broadSigner')) {
        $member=if($global:tokyoRepairProbeMode -eq 'extraSigner') {'serviceAccount:haraka-tokyo-repair-build@spectre-tomstocks-20260227.iam.gserviceaccount.com'} else {'serviceAccount:haraka-tokyo-repair-ctl@spectre-tomstocks-20260227.iam.gserviceaccount.com'}
        $role=if($global:tokyoRepairProbeMode -eq 'extraSigner') {'projects/spectre-tomstocks-20260227/roles/harakaTokyoRepairSignBlob'} else {'roles/iam.serviceAccountTokenCreator'}
        @{bindings=@(@{role=$role;members=@($member)})}
      } elseif ($words[0] -eq 'projects' -and $global:tokyoRepairProbeMode -eq 'broadSignerProject') {
        @{bindings=@(@{role='roles/iam.serviceAccountTokenCreator';members=@('serviceAccount:haraka-tokyo-repair-ctl@spectre-tomstocks-20260227.iam.gserviceaccount.com')})}
      } elseif ($words[0] -eq 'artifacts' -and $words[3] -eq 'haraka-tokyo-repair' -and $global:tokyoRepairProbeMode -in @('publicMirror','releaseMirror','workerMirrorBroad')) {
        $member=switch ($global:tokyoRepairProbeMode) {publicMirror {'allUsers'} releaseMirror {'serviceAccount:haraka-tokyo-repair-release@spectre-tomstocks-20260227.iam.gserviceaccount.com'} workerMirrorBroad {'serviceAccount:haraka-tokyo-repair-build@spectre-tomstocks-20260227.iam.gserviceaccount.com'}}
        @{bindings=@(@{role='roles/artifactregistry.reader';members=@($member)})}
      } elseif ($words[0] -eq 'artifacts' -and $words[3] -eq 'haraka' -and $global:tokyoRepairProbeMode -eq 'sharedWorker') {
        @{bindings=@(@{role='roles/artifactregistry.reader';members=@('serviceAccount:haraka-tokyo-repair-build@spectre-tomstocks-20260227.iam.gserviceaccount.com')})}
      } elseif ($global:tokyoRepairProbeMode -eq 'broadWorker' -and $words[0] -eq 'projects') {
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
  $global:tokyoRepairProbeCalls.Clear();$global:tokyoRepairProbeMode='missingController'
  $image='asia-northeast1-docker.pkg.dev/spectre-tomstocks-20260227/haraka/haraka-tokyo-repair@sha256:'+('0'*64)
  & "$PSScriptRoot/provision.ps1" -Apply -DeployController -ControllerImage $image 6>$null | Out-Null
  if (@($global:tokyoRepairProbeCalls | Where-Object {$_ -match '^run jobs deploy haraka-tokyo-repair '}).Count -ne 1) {throw 'Missing controller must be deployed once.'}
  $signingCalls=@($global:tokyoRepairProbeCalls | Where-Object {$_ -match 'add-iam-policy-binding ' -and $_ -match 'harakaTokyoRepairSignBlob'})
  if($signingCalls.Count -ne 1 -or $signingCalls[0] -notmatch '^iam service-accounts add-iam-policy-binding haraka-tokyo-repair-ctl@spectre-tomstocks-20260227.iam.gserviceaccount.com --member=serviceAccount:haraka-tokyo-repair-ctl@spectre-tomstocks-20260227.iam.gserviceaccount.com ') {throw 'Signing must be granted only to the controller on its own SA.'}
  $global:tokyoRepairProbeCalls.Clear()
  Assert-Fails 'deniedController' 'gcloud run jobs describe failed' @{Apply=$true;DeployController=$true;ControllerImage=$image}
  if (@($global:tokyoRepairProbeCalls | Where-Object {$_ -match '^run jobs deploy '}).Count) {throw 'Permission denied must not be interpreted as an absent job.'}
  Assert-Fails 'mirrorMismatch' 'mirror digest mismatch' @{MirrorWorkerImage=$true;ControllerImage=$image}
  foreach($mode in @('publicMirror','releaseMirror','workerMirrorBroad')) { Assert-Fails $mode 'not private or its grants exceed' @{Readback=$true} }
  Assert-Fails 'sharedWorker' 'must not access the shared image repository' @{Readback=$true}
  Assert-Fails 'extraSigner' 'signing permission must be self-only' @{Readback=$true}
  Assert-Fails 'broadSigner' 'signBlob only, not TokenCreator' @{Readback=$true}
  Assert-Fails 'broadSignerProject' 'project-wide TokenCreator' @{Readback=$true}
  Write-Output 'PASS: 20 provisioning checks (including scoped image access, self-only signBlob, and rejection of broader token-creation grants).'
} finally { Remove-Item Function:\gcloud }
