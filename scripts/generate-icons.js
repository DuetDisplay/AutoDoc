const sharp = require('sharp')
const path = require('path')
const fs = require('fs')

async function generate() {
  const buildDir = path.resolve(__dirname, '..', 'build')
  const resourcesDir = path.resolve(__dirname, '..', 'resources')

  const jobs = [
    // App icon for build/ (used by electron-builder and dev window icon)
    {
      input: path.join(buildDir, 'icon.svg'),
      output: path.join(buildDir, 'icon.png'),
      size: 1024,
    },
    // App icon for resources/ (used by production tray on Windows + packaged app)
    {
      input: path.join(resourcesDir, 'icon.svg'),
      output: path.join(resourcesDir, 'icon.png'),
      size: 256,
    },
    // macOS tray template 1x (18x18)
    {
      input: path.join(buildDir, 'trayTemplate.svg'),
      output: path.join(buildDir, 'trayTemplate.png'),
      size: 18,
    },
    // macOS tray template 2x (36x36)
    {
      input: path.join(buildDir, 'trayTemplate.svg'),
      output: path.join(buildDir, 'trayTemplate@2x.png'),
      size: 36,
    },
    // macOS tray template for production (packaged into resources/)
    {
      input: path.join(buildDir, 'trayTemplate.svg'),
      output: path.join(resourcesDir, 'trayTemplate.png'),
      size: 18,
    },
    {
      input: path.join(buildDir, 'trayTemplate.svg'),
      output: path.join(resourcesDir, 'trayTemplate@2x.png'),
      size: 36,
    },
    // macOS tray — recording (colored, 18 + 36)
    {
      input: path.join(buildDir, 'trayRecording.svg'),
      output: path.join(buildDir, 'trayRecording.png'),
      size: 18,
    },
    {
      input: path.join(buildDir, 'trayRecording.svg'),
      output: path.join(buildDir, 'trayRecording@2x.png'),
      size: 36,
    },
    {
      input: path.join(buildDir, 'trayRecording.svg'),
      output: path.join(resourcesDir, 'trayRecording.png'),
      size: 18,
    },
    {
      input: path.join(buildDir, 'trayRecording.svg'),
      output: path.join(resourcesDir, 'trayRecording@2x.png'),
      size: 36,
    },
  ]

  for (const job of jobs) {
    if (!fs.existsSync(job.input)) {
      console.warn(`Skipping ${job.input} (not found)`)
      continue
    }
    await sharp(job.input)
      .resize(job.size, job.size)
      .png()
      .toFile(job.output)
    console.log(`Generated ${path.relative(process.cwd(), job.output)} (${job.size}x${job.size})`)
  }
}

generate().catch((err) => {
  console.error('Icon generation failed:', err)
  process.exit(1)
})
