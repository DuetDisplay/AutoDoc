const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')

const QA_APP_ID = 'com.kairos.autodoc.qa'
const QA_PRODUCT_NAME = 'AutoDoc QA'
const QA_PACKAGE_NAME = 'autodoc-qa'
const QA_NSIS_INCLUDE = 'build/installer-qa.nsh'
const FEEDBACK_PROMPT_QA_MARKERS = [
  'AUTODOC_QA_FEEDBACK_SIMULATOR_V1',
  'qa:feedback-prompt:get-state',
  'qa:feedback-prompt:set-scenario'
]
const QA_ISOLATION_MARKERS = ['127.0.0.1:11436', 'autodoc-qa-']

function listBuildFiles(rootPath) {
  if (!existsSync(rootPath)) return []
  const files = []
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = join(rootPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...listBuildFiles(entryPath))
    } else if (/\.(?:c?js|mjs|html)$/.test(entry.name)) {
      files.push(entryPath)
    }
  }
  return files
}

function readCompiledBuild(outPath) {
  const files = listBuildFiles(outPath)
  if (files.length === 0) {
    throw new Error(`No compiled Electron output found under ${outPath}`)
  }
  return files.map((filePath) => readFileSync(filePath, 'utf8')).join('\n')
}

function detectCompiledFlavor(outPath) {
  const output = readCompiledBuild(outPath)
  const presentMarkers = QA_ISOLATION_MARKERS.filter((marker) => output.includes(marker))
  if (presentMarkers.length === 0) return 'production'
  if (presentMarkers.length === QA_ISOLATION_MARKERS.length) return 'qa'
  throw new Error(
    `Compiled output has an incomplete QA isolation boundary. Found: ${presentMarkers.join(', ')}`
  )
}

function verifyCompiledFlavor(outPath, expectedFlavor) {
  const actualFlavor = detectCompiledFlavor(outPath)
  if (actualFlavor !== expectedFlavor) {
    throw new Error(`Expected a ${expectedFlavor} build, but compiled output is ${actualFlavor}.`)
  }

  const output = readCompiledBuild(outPath)
  const presentFeedbackPromptMarkers = FEEDBACK_PROMPT_QA_MARKERS.filter((marker) =>
    output.includes(marker)
  )
  if (
    presentFeedbackPromptMarkers.length > 0 &&
    presentFeedbackPromptMarkers.length !== FEEDBACK_PROMPT_QA_MARKERS.length
  ) {
    throw new Error(
      `Compiled output has an incomplete feedback-prompt QA boundary. Found: ${presentFeedbackPromptMarkers.join(', ')}`
    )
  }
  const presentIsolationMarkers = QA_ISOLATION_MARKERS.filter((marker) => output.includes(marker))
  if (expectedFlavor === 'qa' && presentIsolationMarkers.length !== QA_ISOLATION_MARKERS.length) {
    throw new Error(
      `QA output is missing runtime-isolation markers: ${QA_ISOLATION_MARKERS.filter((marker) => !presentIsolationMarkers.includes(marker)).join(', ')}`
    )
  }
  if (expectedFlavor === 'production' && presentIsolationMarkers.length > 0) {
    throw new Error(
      `Production output contains QA runtime-isolation markers: ${presentIsolationMarkers.join(', ')}`
    )
  }
  if (
    expectedFlavor === 'qa' &&
    presentFeedbackPromptMarkers.length !== FEEDBACK_PROMPT_QA_MARKERS.length
  ) {
    throw new Error('QA output is missing the feedback-prompt simulator markers.')
  }
  console.log(`[build-flavor] Verified ${expectedFlavor} compiled output`)
}

function hasPublisher(configuration) {
  if (!configuration) return false
  return !Array.isArray(configuration) || configuration.length > 0
}

function verifyQANsisIsolation() {
  const installerScript = readFileSync(resolve(process.cwd(), QA_NSIS_INCLUDE), 'utf8')
  if (
    !installerScript.includes('RMDir /r "$APPDATA\\AutoDoc QA"') ||
    installerScript.includes('AUTODOC_TEST_USER_DATA_DIR')
  ) {
    throw new Error(
      'QA uninstaller cleanup must target only $APPDATA\\AutoDoc QA and must not accept a path override.'
    )
  }
}

async function beforePack(context) {
  const outPath = resolve(process.cwd(), 'out')
  const flavor = detectCompiledFlavor(outPath)
  const appId = context.packager.config.appId
  const productName = context.packager.config.productName
  const packageName = context.packager.config.extraMetadata?.name
  const windowsExecutableName = context.packager.config.win?.executableName
  const nsisInclude = context.packager.config.nsis?.include

  if (flavor === 'qa') {
    verifyQANsisIsolation()
    if (
      appId !== QA_APP_ID ||
      productName !== QA_PRODUCT_NAME ||
      packageName !== QA_PACKAGE_NAME ||
      windowsExecutableName !== QA_PACKAGE_NAME ||
      nsisInclude !== QA_NSIS_INCLUDE
    ) {
      throw new Error(
        `Refusing to package QA output with a non-isolated identity: product=${productName}, appId=${appId}, package=${packageName}, executable=${windowsExecutableName}, nsisInclude=${nsisInclude}. Use electron-builder.qa.yml.`
      )
    }

    const platformPublish =
      context.electronPlatformName === 'darwin'
        ? context.packager.config.mac?.publish
        : context.electronPlatformName === 'win32'
          ? context.packager.config.win?.publish
          : context.packager.config.linux?.publish
    if (hasPublisher(context.packager.config.publish) || hasPublisher(platformPublish)) {
      throw new Error('Refusing to package a QA build with an updater publisher configured.')
    }
  } else if (
    appId === QA_APP_ID ||
    productName === QA_PRODUCT_NAME ||
    packageName === QA_PACKAGE_NAME ||
    windowsExecutableName === QA_PACKAGE_NAME ||
    nsisInclude === QA_NSIS_INCLUDE
  ) {
    throw new Error('Refusing to package production output with the AutoDoc QA identity.')
  }

  const appOutDir = context.appOutDir
  if (appOutDir && existsSync(appOutDir) && !statSync(appOutDir).isDirectory()) {
    throw new Error(`Invalid electron-builder output directory: ${appOutDir}`)
  }
  console.log(`[build-flavor] Packaging boundary verified for ${flavor}`)
}

module.exports.default = beforePack
module.exports.detectCompiledFlavor = detectCompiledFlavor
module.exports.verifyCompiledFlavor = verifyCompiledFlavor

if (require.main === module) {
  const expectedFlavor = process.argv[2]
  if (expectedFlavor !== 'production' && expectedFlavor !== 'qa') {
    throw new Error('Usage: node scripts/verify-build-flavor.cjs <production|qa>')
  }
  verifyCompiledFlavor(resolve(process.cwd(), 'out'), expectedFlavor)
  if (expectedFlavor === 'qa') verifyQANsisIsolation()
}
