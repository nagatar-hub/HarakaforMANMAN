#Requires -Version 7.0
<##
Default: read-only discovery and plan. -Apply adds only the named repair resources
and exact IAM bindings. Existing roles/conditions outside this contract are never
replaced. No API is enabled, no credential value is read, and no model is called.
Controller image build/deploy remains an explicit release operation.
##>
[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$Readback,
  [switch]$PrintContract,
  [switch]$DeployController,
  [switch]$EnableSchedule,
  [string]$ControllerImage,
  [string]$Account = 'nagata.r@tomstocks.net'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$project = 'spectre-tomstocks-20260227'
$projectNumber = '569936489397'
$region = 'asia-northeast1'
$job = 'haraka-tokyo-repair'
$ctl = "$job-ctl@$project.iam.gserviceaccount.com"
$worker = "$job-build@$project.iam.gserviceaccount.com"
$release = "$job-release@$project.iam.gserviceaccount.com"
$runtime = "$projectNumber-compute@developer.gserviceaccount.com"
$state = "$project-haraka-tokyo-repair-state"
$artifacts = "$project-haraka-tokyo-repair-artifacts"
$sourceBucket = "${project}_cloudbuild"
$connection = 'haraka-tokyo-repair-github'
$repository = 'harakafor-manman'
$repositoryResource = "projects/$project/locations/$region/connections/$connection/repositories/$repository"
$remote = 'https://github.com/nagatar-hub/HarakaforMANMAN.git'
$modelSecret = 'haraka-tokyo-repair-openai-api-key'
$scheduler = 'haraka-tokyo-repair-15min'
$imageRepository = "$region-docker.pkg.dev/$project/haraka/haraka-tokyo-repair"
$logView = 'haraka-tokyo-repair'
$logFilter = 'resource.type="cloud_run_job" AND resource.labels.project_id="spectre-tomstocks-20260227" AND resource.labels.job_name=~"^haraka-manman-akihabara-(sync|generate|watchdog)$"'
$envContract = [ordered]@{
  GCLOUD_PROJECT=$project; GCP_REGION=$region; STORE_NAME='manman-akihabara'
  REPAIR_STATE_BUCKET=$state; REPAIR_ARTIFACT_BUCKET=$artifacts
  REPAIR_SELF_IMAGE=$ControllerImage; REPAIR_OPENAI_SECRET=$modelSecret
  REPAIR_WORKER_SA=$worker; REPAIR_RELEASE_BUILD_SA=$release
  REPAIR_SOURCE_REPO=$repositoryResource; TOKYO_REPAIR_FIXTURE_BUCKET=$artifacts
}
$secrets = [ordered]@{
  SUPABASE_URL='haraka-supabase-url:latest'
  SUPABASE_SERVICE_ROLE_KEY='gacha-admin-supabase-secret-key-v2:1'
  PELEKA_TOKYO_CATALOG_URL='haraka-peleka-tokyo-catalog-url:latest'
  PELEKA_TOKYO_CATALOG_TOKEN='haraka-peleka-tokyo-catalog-token:latest'
}
$contract = [ordered]@{
  project=$project; projectNumber=$projectNumber; region=$region; controllerJob=$job
  controllerServiceAccount=$ctl; workerServiceAccount=$worker; releaseServiceAccount=$release
  stateBucket=$state; artifactBucket=$artifacts; sourceBucket=$sourceBucket
  repository=$repositoryResource; imageRepository=$imageRepository
  logView="projects/$project/locations/global/buckets/_Default/views/$logView"
  scheduler=$scheduler; schedule='*/15 * * * *'; timeZone='Asia/Tokyo'
  environment=$envContract; secretReferences=$secrets
}
if ($PrintContract) { $contract | ConvertTo-Json -Depth 8; return }
if (($DeployController -or $EnableSchedule) -and !$Apply) { throw 'Deployment/schedule changes require -Apply.' }
if ($EnableSchedule -and !$DeployController) { throw '-EnableSchedule requires -DeployController and a verified immutable image.' }
if ($DeployController -and $ControllerImage -notmatch ('^'+[regex]::Escape($imageRepository)+'@sha256:[0-9a-f]{64}$')) {
  throw 'ControllerImage must be the agreed controller repository with an immutable sha256 digest.'
}
$scratch = Join-Path $PSScriptRoot '.provision-local'
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
$policyCache = @{}
$planned = [Collections.Generic.List[string]]::new()

function Invoke-Gcloud([string[]]$Arguments, [switch]$Optional) {
  $errorFile = Join-Path $scratch ([guid]::NewGuid().ToString()+'.stderr')
  try {
    $result = & gcloud @Arguments "--project=$project" "--account=$Account" --quiet --format=json 2> $errorFile
    $code = $LASTEXITCODE
    if ($code -ne 0) {
      $reason = [IO.File]::ReadAllText($errorFile)
      if ($Optional -and $reason -match '(NOT_FOUND|Not Found|does not exist|was not found|not found)') { return $null }
      throw "gcloud $($Arguments[0..([Math]::Min(2,$Arguments.Length-1))] -join ' ') failed (exit $code). $($reason.Trim())"
    }
    $joined = $result -join "`n"
    if ($joined.Trim()) { return $joined | ConvertFrom-Json -Depth 100 }
    return $null
  } finally { if (Test-Path -LiteralPath $errorFile) { Remove-Item -LiteralPath $errorFile } }
}
function Change([string]$Label, [string[]]$Arguments) {
  $planned.Add($Label)
  if ($Apply) { Write-Host "APPLY $Label"; $null = Invoke-Gcloud $Arguments }
  else { Write-Host "PLAN  $Label" }
}
function JsonFile([string]$Name, $Value) {
  $path = Join-Path $scratch "$Name.json"
  [IO.File]::WriteAllText($path, ($Value | ConvertTo-Json -Depth 30), $utf8)
  return $path
}
function EnsureRole([string]$Name, [string[]]$Permissions) {
  $role = Invoke-Gcloud @('iam','roles','describe',$Name) -Optional
  if ($role) {
    if ($role.deleted -or @(Compare-Object @($role.includedPermissions | Sort-Object) @($Permissions | Sort-Object)).Count) {
      throw "Existing custom role $Name differs; refusing to expand or replace it."
    }
  } else {
    $file = JsonFile $Name @{title=$Name; description='Dedicated Tokyo repair minimum permissions'; stage='GA'; includedPermissions=$Permissions}
    Change "create custom role $Name" @('iam','roles','create',$Name,"--file=$file")
  }
  return "projects/$project/roles/$Name"
}
function Bind([string]$Scope, [string[]]$GetPolicy, [string[]]$AddBinding, [string]$Member, [string]$Role, [string]$Condition='') {
  if (!$policyCache.ContainsKey($Scope)) { $policyCache[$Scope] = Invoke-Gcloud $GetPolicy -Optional }
  $existing = @($policyCache[$Scope].bindings | Where-Object {
    $_.role -eq $Role -and $Member -in $_.members -and
    (($Condition -eq '' -and !$_.condition) -or ($Condition -ne '' -and $_.condition.expression -eq $Condition))
  })
  if ($existing.Count) { return }
  $args = @($AddBinding) + @("--member=$Member","--role=$Role")
  if ($Condition) {
    $conditionFile = JsonFile ('condition-'+[guid]::NewGuid().ToString()) @{title='haraka_tokyo_repair_scope'; expression=$Condition}
    $args += "--condition-from-file=$conditionFile"
  } elseif ($Scope -notlike 'job:*' -and $Scope -notlike 'connection:*') { $args += '--condition=None' }
  Change "bind $Member $Role on $Scope$(if ($Condition) {' [scoped objects]'})" $args
}
function ProjectBind([string]$Member,[string]$Role) {
  Bind 'project' @('projects','get-iam-policy',$project) @('projects','add-iam-policy-binding',$project) $Member $Role
}
function BucketBind([string]$Bucket,[string]$Member,[string]$Role,[string]$Condition='') {
  Bind "bucket:$Bucket" @('storage','buckets','get-iam-policy',"gs://$Bucket") @('storage','buckets','add-iam-policy-binding',"gs://$Bucket") $Member $Role $Condition
}
function JobBind([string]$JobName,[string]$Member,[string]$Role) {
  Bind "job:$JobName" @('run','jobs','get-iam-policy',$JobName,"--region=$region") @('run','jobs','add-iam-policy-binding',$JobName,"--region=$region") $Member $Role
}
function SecretBind([string]$Secret,[string]$Member,[string]$Role) {
  Bind "secret:$Secret" @('secrets','get-iam-policy',$Secret) @('secrets','add-iam-policy-binding',$Secret) $Member $Role
}

# Preconditions are read-only. Disabled APIs or incorrect projects fail closed.
$projectInfo = Invoke-Gcloud @('projects','describe',$project)
if ([string]$projectInfo.projectNumber -ne $projectNumber) { throw 'Project identity mismatch.' }
$enabled = @(Invoke-Gcloud @('services','list','--enabled')) | ForEach-Object { $_.config.name }
foreach ($api in @('run.googleapis.com','cloudbuild.googleapis.com','cloudscheduler.googleapis.com','secretmanager.googleapis.com','artifactregistry.googleapis.com','storage.googleapis.com','iam.googleapis.com')) {
  if ($api -notin $enabled) { throw "Required existing API $api is disabled; this script will not enable it." }
}
$originalConnection = Invoke-Gcloud @('builds','connections','describe','haraka-github',"--region=$region")
if ($originalConnection.installationState.stage -ne 'COMPLETE' -or [string]$originalConnection.githubConfig.appInstallationId -ne '116076180') { throw 'Existing GitHub installation mismatch.' }
$authorizer = $originalConnection.githubConfig.authorizerCredential.oauthTokenSecretVersion
if ($authorizer -notmatch "^projects/($project|$projectNumber)/secrets/haraka-github-github-oauthtoken-[a-z0-9]+/versions/(latest|[0-9]+)$") { throw 'Unexpected authorizer secret reference.' }
foreach ($suffix in @('ctl','build','release')) {
  $name = "$job-$suffix"
  $sa = Invoke-Gcloud @('iam','service-accounts','describe',"$name@$project.iam.gserviceaccount.com") -Optional
  if (!$sa) { Change "create service account $name" @('iam','service-accounts','create',$name,"--display-name=$name") }
  elseif ($sa.disabled) { throw "Service account $name is disabled." }
}
foreach ($bucket in @($state,$artifacts)) {
  $b = Invoke-Gcloud @('storage','buckets','describe',"gs://$bucket",'--raw') -Optional
  if (!$b) {
    Change "create private bucket $bucket" @('storage','buckets','create',"gs://$bucket","--location=$region",'--uniform-bucket-level-access','--public-access-prevention')
  } elseif ([string]$b.projectNumber -ne $projectNumber -or $b.location.ToLowerInvariant() -ne $region -or !$b.iamConfiguration.uniformBucketLevelAccess.enabled -or $b.iamConfiguration.publicAccessPrevention -ne 'enforced') {
    throw "Existing bucket $bucket violates project/location/private-access contract."
  }
}
$c = Invoke-Gcloud @('builds','connections','describe',$connection,"--region=$region") -Optional
if (!$c) {
  Change "create isolated GitHub connection $connection" @('builds','connections','create','github',$connection,"--region=$region","--app-installation-id=116076180","--authorizer-token-secret-version=$authorizer")
} elseif ($c.installationState.stage -ne 'COMPLETE' -or [string]$c.githubConfig.appInstallationId -ne '116076180') { throw 'Repair GitHub connection mismatch.' }
$repos = if ($c -or $Apply) { @(Invoke-Gcloud @('builds','repositories','list',"--connection=$connection","--region=$region")) } else { @() }
if (@($repos | Where-Object { $_.name -ne $repositoryResource -or $_.remoteUri -ne $remote }).Count) { throw 'Repair connection contains an unexpected repository; token grant refused.' }
if (!$repos.Count) { Change "link only HarakaforMANMAN" @('builds','repositories','create',$repository,"--connection=$connection","--region=$region","--remote-uri=$remote") }
$key = Invoke-Gcloud @('secrets','describe',$modelSecret) -Optional
if (!$key) { Change "create empty model-key secret (no credential payload)" @('secrets','create',$modelSecret,'--replication-policy=user-managed',"--locations=$region") }
$view = Invoke-Gcloud @('logging','views','describe',$logView,'--bucket=_Default','--location=global') -Optional
if (!$view) { Change 'create Tokyo job-only log view' @('logging','views','create',$logView,'--bucket=_Default','--location=global',"--log-filter=$logFilter") }
elseif ($view.filter -ne $logFilter) { throw 'Existing log view filter differs; refusing broader log access.' }

$buildRole = EnsureRole 'harakaTokyoRepairBuildSubmit' @('cloudbuild.builds.create','cloudbuild.builds.get','cloudbuild.operations.get')
$operationRole = EnsureRole 'harakaTokyoRepairRunOperationRead' @('run.operations.get')
$updateRole = EnsureRole 'harakaTokyoRepairJobUpdate' @('run.jobs.get','run.jobs.update','run.jobs.run','run.jobs.runWithOverrides','run.executions.get','run.executions.list')
$invokeRole = EnsureRole 'harakaTokyoRepairJobInvoke' @('run.jobs.get','run.jobs.run','run.executions.get','run.executions.list')
$tokenRole = EnsureRole 'harakaTokyoRepairRepoToken' @('cloudbuild.repositories.get','cloudbuild.repositories.list','cloudbuild.repositories.accessReadWriteToken')
$objectRead = EnsureRole 'harakaTokyoRepairObjectRead' @('storage.objects.get')
$modelMetadata = EnsureRole 'harakaTokyoRepairModelMetadata' @('secretmanager.versions.get')
$ctlMember = "serviceAccount:$ctl"; $workerMember = "serviceAccount:$worker"; $releaseMember = "serviceAccount:$release"
ProjectBind $ctlMember $buildRole
ProjectBind $ctlMember $operationRole
foreach ($member in @($ctlMember,$workerMember,$releaseMember)) { ProjectBind $member 'roles/logging.logWriter' }
foreach ($target in @('haraka-manman-akihabara-sync','haraka-manman-akihabara-generate')) { JobBind $target $ctlMember $updateRole }
JobBind 'haraka-manman-akihabara-watchdog' $ctlMember $invokeRole
foreach ($targetSa in @($worker,$release,$runtime)) {
  Bind "sa:$targetSa" @('iam','service-accounts','get-iam-policy',$targetSa) @('iam','service-accounts','add-iam-policy-binding',$targetSa) $ctlMember 'roles/iam.serviceAccountUser'
}
Bind "connection:$connection" @('builds','connections','get-iam-policy',$connection,"--region=$region") @('builds','connections','add-iam-policy-binding',$connection,"--region=$region") $ctlMember $tokenRole
Bind "logview:$logView" @('logging','views','get-iam-policy',$logView,'--bucket=_Default','--location=global') @('logging','views','add-iam-policy-binding',$logView,'--bucket=_Default','--location=global') $ctlMember 'roles/logging.viewAccessor'
BucketBind $state $ctlMember 'roles/storage.objectAdmin'
BucketBind $artifacts $ctlMember 'roles/storage.objectAdmin'
$objectPrefix = "projects/_/buckets/$artifacts/objects/"
BucketBind $artifacts $workerMember 'roles/storage.objectCreator' "resource.name.startsWith('${objectPrefix}proposals/')"
BucketBind $artifacts $releaseMember $objectRead "resource.name.startsWith('${objectPrefix}proposals/') || resource.name.startsWith('${objectPrefix}tokyo-repair-fixtures/')"
BucketBind $artifacts $releaseMember 'roles/storage.objectCreator' "resource.name.startsWith('${objectPrefix}verified/')"
BucketBind $sourceBucket $releaseMember $objectRead
# Production sync already has broader storage access; record the capture prefix
# explicitly without changing existing shared grants.
BucketBind $artifacts "serviceAccount:$runtime" 'roles/storage.objectCreator' "resource.name.startsWith('${objectPrefix}tokyo-repair-fixtures/')"
SecretBind $modelSecret $workerMember 'roles/secretmanager.secretAccessor'
SecretBind $modelSecret $ctlMember $modelMetadata
foreach ($ref in $secrets.Values) { SecretBind ($ref.Split(':')[0]) $ctlMember 'roles/secretmanager.secretAccessor' }
Bind 'ar:haraka' @('artifacts','repositories','get-iam-policy','haraka',"--location=$region") @('artifacts','repositories','add-iam-policy-binding','haraka',"--location=$region") $releaseMember 'roles/artifactregistry.writer'

if ($DeployController) {
  $existing = Invoke-Gcloud @('run','jobs','describe',$job,"--region=$region") -Optional
  if ($existing -and $existing.spec.template.spec.template.spec.serviceAccountName -ne $ctl) { throw 'Existing controller runtime identity differs.' }
  $uri = "https://run.googleapis.com/v2/projects/$project/locations/$region/jobs/${job}:run"
  $schedule = Invoke-Gcloud @('scheduler','jobs','describe',$scheduler,"--location=$region") -Optional
  if ($schedule -and ($schedule.httpTarget.uri -ne $uri -or $schedule.httpTarget.oauthToken.serviceAccountEmail -ne $ctl)) { throw 'Existing scheduler target/identity differs.' }
  if ($schedule -and $schedule.state -ne 'PAUSED') {
    Change 'pause scheduler before controller replacement' @('scheduler','jobs','pause',$scheduler,"--location=$region")
  }
  $envFile = JsonFile 'controller-env' $envContract
  $secretFlags = ($secrets.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ','
  Change 'deploy immutable controller image' @('run','jobs','deploy',$job,"--region=$region","--image=$ControllerImage","--service-account=$ctl",'--tasks=1','--parallelism=1','--max-retries=0','--task-timeout=10800s','--cpu=1','--memory=1Gi',"--env-vars-file=$envFile","--set-secrets=$secretFlags")
  JobBind $job $ctlMember $invokeRole
  if (!$schedule) {
    # Create with an impossible-near-term date first, then pause before installing
    # the regular cadence. This avoids a first execution during initial setup.
    Change 'create dormant scheduler' @('scheduler','jobs','create','http',$scheduler,"--location=$region",'--schedule=0 0 29 2 *','--time-zone=Asia/Tokyo',"--uri=$uri",'--http-method=POST','--message-body={}',"--oauth-service-account-email=$ctl",'--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform','--attempt-deadline=180s','--max-retry-attempts=0')
    Change 'pause new scheduler' @('scheduler','jobs','pause',$scheduler,"--location=$region")
  }
  Change 'set scheduler cadence' @('scheduler','jobs','update','http',$scheduler,"--location=$region",'--schedule=*/15 * * * *','--time-zone=Asia/Tokyo','--max-retry-attempts=0')
  if ($EnableSchedule) {
    # The trusted controller reads only version metadata, waits when unavailable,
    # and resumes naturally after a credential version is supplied by an operator.
    Change 'enable monitoring scheduler after explicit release' @('scheduler','jobs','resume',$scheduler,"--location=$region")
  }
}

if ($Readback -or $Apply) {
  # Check the least-privilege boundary using policy metadata only. No tokens or
  # secret versions are accessed; permissions inherited from organization/folder
  # policies still require the deployment operator's separate IAM review.
  $projectPolicy = Invoke-Gcloud @('projects','get-iam-policy',$project)
  foreach ($member in @($workerMember,$releaseMember)) {
    $unexpected = @($projectPolicy.bindings | Where-Object { $member -in $_.members -and $_.role -ne 'roles/logging.logWriter' })
    if ($unexpected.Count) { throw "Unexpected project-level grant on $member; readback failed." }
  }
  $statePolicy = Invoke-Gcloud @('storage','buckets','get-iam-policy',"gs://$state") -Optional
  if (@($statePolicy.bindings | Where-Object { $workerMember -in $_.members -or $releaseMember -in $_.members }).Count) { throw 'Worker/release must not access the state bucket.' }
  $artifactPolicy = Invoke-Gcloud @('storage','buckets','get-iam-policy',"gs://$artifacts") -Optional
  foreach ($binding in $artifactPolicy.bindings) {
    if ($workerMember -in $binding.members -and ($binding.role -ne 'roles/storage.objectCreator' -or $binding.condition.expression -ne "resource.name.startsWith('${objectPrefix}proposals/')")) { throw 'Worker artifact access exceeds proposals create-only.' }
  }
  $modelPolicy = Invoke-Gcloud @('secrets','get-iam-policy',$modelSecret) -Optional
  if (@($modelPolicy.bindings | Where-Object { $releaseMember -in $_.members -or ($ctlMember -in $_.members -and $_.role -ne $modelMetadata) }).Count) { throw 'Controller may read model version metadata only; release must not access model credentials.' }
  $contract | ConvertTo-Json -Depth 8
  Write-Host 'Readback checked exact project and direct policy boundaries; no credential values were read.'
}
Write-Host "Completed $(if ($Apply) {'apply'} else {'read-only plan'}): $($planned.Count) requested additions/actions."
