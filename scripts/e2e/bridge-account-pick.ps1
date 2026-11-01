# 真实点击验证：微信桥接页「点账号卡切号」
# 用法：pwsh -File scripts/e2e/bridge-account-pick.ps1
# 前提：已经在测试根目录（.e2e-tmp/root）里启动 WhaleLauncher.exe 与内核。
param(
  [string]$AppPidFile = '',
  [string]$RootDir = '',
  [string]$PickAccount = 'wxid_alpha0001_ab12'
)
$script:PickAccount = $PickAccount

$ErrorActionPreference = 'Stop'
$src = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $AppPidFile) { $AppPidFile = Join-Path $src '.e2e-tmp\app.pid' }
if (-not $RootDir) { $RootDir = Join-Path $src '.e2e-tmp\root' }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

function Find-ById($scope, $id) {
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
  return $scope.FindFirst($TS::Descendants, $c)
}
function Find-ByClass($scope, $class) {
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, $class)
  return $scope.FindFirst($TS::Descendants, $c)
}
function Find-ByType($scope, $type) {
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type)
  return $scope.FindFirst($TS::Descendants, $c)
}
function Get-Texts($scope) {
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Text)
  return @($scope.FindAll($TS::Descendants, $c) | ForEach-Object { $_.Current.Name })
}

$appPid = [int](Get-Content $AppPidFile)
$proc = Get-Process -Id $appPid
$root = $AE::FromHandle([IntPtr]$proc.MainWindowHandle)

# 切到「微信桥接」
$navItem = $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, '微信桥接')))
if (-not $navItem) { throw '找不到左侧「微信桥接」导航项' }
$navItem.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
Start-Sleep -Seconds 3

$page = Find-ByClass $root 'BridgePage'
if (-not $page) { throw '没切到桥接页' }

$accounts = Find-ById $page 'Accounts'
if (-not $accounts) { throw '找不到账号列表' }

# 找目标账号卡（可点的那张）
$cards = $accounts.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
"卡片数=$($cards.Count)"
$targetCard = $null
foreach ($card in $cards) {
  $texts = Get-Texts $card
  "  卡片: $($texts -join ' | ')"
  if ($texts.Count -gt 0 -and $texts[0] -like "$($script:PickAccount)*") { $targetCard = $card }
}
if (-not $targetCard) { throw "没有账号 $($script:PickAccount) 的卡片" }

$btn = Find-ByType $targetCard $CT::Button
if (-not $btn) { throw '卡片里没有按钮（界面结构变了？）' }
$before = (Get-Content (Join-Path $RootDir 'config.json') -Raw | ConvertFrom-Json).wechat.account
"点击前 wechat.account='$before'"
$btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Start-Sleep -Seconds 3

$after = (Get-Content (Join-Path $RootDir 'config.json') -Raw | ConvertFrom-Json).wechat.account
"点击后 wechat.account='$after'"

$hint = (Find-ById $page 'AccountHint').Current.Name
$status = (Find-ById $page 'SwitchHint').Current.Name
$txt = (Find-ById $page 'TxtAccount').GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
"提示行=$hint"
"状态行=$status"
"输入框=$txt"

$cards2 = $accounts.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($card in $cards2) { "  卡片(点后): $((Get-Texts $card) -join ' | ')" }

if ($after -ne $script:PickAccount) { throw "配置没写进去：期望 $($script:PickAccount)，实际 $after" }
if ($txt -ne $script:PickAccount) { throw "输入框没同步：$txt" }
if (-not ($status -like '*已切到*')) { throw "状态行没提示切换：$status" }

# 再验「不固定（按最近活跃）」
$auto = Find-ById $page 'BtnAutoAccount'
$auto.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Start-Sleep -Seconds 3
$autoVal = (Get-Content (Join-Path $RootDir 'config.json') -Raw | ConvertFrom-Json).wechat.account
"点「不固定」后 wechat.account='$autoVal'"
if ($autoVal -ne '') { throw "「不固定」没清空账号：$autoVal" }
$hint2 = (Find-ById $page 'AccountHint').Current.Name
"提示行(不固定)=$hint2"
if (-not ($hint2 -like '*按最近活跃*')) { throw "提示行没更新：$hint2" }

'OK 全部通过'
