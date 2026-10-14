export interface SpeechLicenseNotice {
  name: string
  license: string
  url: string
  licenseUrl?: string
  attribution?: string
  version?: string
  runtime?: string
  text?: string
}

const CC_BY = 'https://creativecommons.org/licenses/by/4.0/'
const MIT = 'https://opensource.org/license/mit'

/** Static attributions for speech models and engines shipped or downloaded here. */
export function speechLicenseNotices(platform: string): SpeechLicenseNotice[] {
  const common: SpeechLicenseNotice[] = [
    {
      name: 'Canary-1B-v2',
      license: 'CC-BY-4.0',
      url: 'https://huggingface.co/nvidia/canary-1b-v2',
      licenseUrl: CC_BY,
      attribution:
        platform === 'darwin'
          ? 'Canary-1B-v2 © NVIDIA. MLX 8-bit conversion by Mediform changes the format and quantizes the weights.'
          : 'Canary-1B-v2 © NVIDIA. ONNX conversion by istupakov changes the format and may quantize the weights.'
    },
    {
      name: 'Whisper large-v3-turbo',
      license: 'MIT',
      url: 'https://huggingface.co/openai/whisper-large-v3-turbo',
      licenseUrl: MIT,
      attribution:
        platform === 'darwin'
          ? 'OpenAI. AutoDoc uses the mlx-community MLX conversion.'
          : 'OpenAI. AutoDoc uses converted CTranslate2 or ggml weights for the selected engine.'
    },
    {
      name: 'Distil-Whisper',
      license: 'MIT',
      url: 'https://huggingface.co/distil-whisper/distil-large-v3',
      licenseUrl: MIT,
      attribution: 'Hugging Face Distil-Whisper contributors.'
    },
    {
      name: 'Silero VAD',
      license: 'MIT',
      url: 'https://github.com/snakers4/silero-vad',
      licenseUrl: 'https://github.com/snakers4/silero-vad/blob/master/LICENSE',
      attribution: 'Silero Team. AutoDoc uses the istupakov ONNX conversion.'
    },
    {
      name: 'onnx-asr',
      license: 'MIT',
      url: 'https://github.com/istupakov/onnx-asr',
      licenseUrl: 'https://github.com/istupakov/onnx-asr/blob/main/LICENSE'
    },
    {
      name: 'ONNX Runtime',
      license: 'MIT',
      url: 'https://github.com/microsoft/onnxruntime',
      licenseUrl: 'https://github.com/microsoft/onnxruntime/blob/main/LICENSE'
    },
    {
      name: 'Python',
      license: 'PSF-2.0',
      url: 'https://www.python.org/',
      licenseUrl: 'https://docs.python.org/3.11/license.html'
    }
  ]
  if (platform === 'darwin')
    return [
      ...common,
      {
        name: 'MLX',
        license: 'MIT',
        url: 'https://github.com/ml-explore/mlx',
        licenseUrl: 'https://github.com/ml-explore/mlx/blob/main/LICENSE'
      },
      {
        name: 'mlx-whisper',
        license: 'MIT',
        url: 'https://github.com/ml-explore/mlx-examples/tree/main/whisper',
        licenseUrl: 'https://github.com/ml-explore/mlx-examples/blob/main/LICENSE'
      },
      {
        name: 'mlx-audio',
        license: 'MIT',
        url: 'https://github.com/Blaizzy/mlx-audio',
        licenseUrl: 'https://github.com/Blaizzy/mlx-audio/blob/main/LICENSE'
      }
    ]
  if (platform === 'win32')
    return [
      ...common,
      {
        name: 'whisper.cpp / ggml',
        license: 'MIT',
        url: 'https://github.com/ggml-org/whisper.cpp',
        licenseUrl: 'https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE'
      },

      {
        name: 'Whisper small.en / base.en',
        license: 'MIT',
        url: 'https://github.com/openai/whisper',
        licenseUrl: 'https://github.com/openai/whisper/blob/main/LICENSE',
        attribution:
          'OpenAI. Converted CTranslate2 or ggml weights used by English fallback engines.'
      },
      {
        name: 'Parakeet TDT 0.6B v3',
        license: 'CC-BY-4.0',
        url: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3',
        licenseUrl: CC_BY,
        attribution:
          'Parakeet TDT 0.6B v3 © NVIDIA. ONNX conversion by istupakov changes the format and may quantize the weights.'
      },
      {
        name: 'CTranslate2',
        license: 'MIT',
        url: 'https://github.com/OpenNMT/CTranslate2',
        licenseUrl: 'https://github.com/OpenNMT/CTranslate2/blob/master/LICENSE'
      },
      {
        name: 'faster-whisper',
        license: 'MIT',
        url: 'https://github.com/SYSTRAN/faster-whisper',
        licenseUrl: 'https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE'
      },
      {
        name: 'NVIDIA CUDA redistributables',
        license: 'NVIDIA license terms',
        url: 'https://developer.nvidia.com/cuda-toolkit',
        licenseUrl: 'https://docs.nvidia.com/cuda/eula/index.html',
        attribution: 'NVIDIA Corporation. Downloaded for compatible NVIDIA GPU speech engines.'
      },
      {
        name: 'NVIDIA cuDNN redistributables',
        license: 'NVIDIA license terms',
        url: 'https://developer.nvidia.com/cudnn',
        licenseUrl: 'https://docs.nvidia.com/deeplearning/cudnn/backend/latest/reference/eula.html',
        attribution: 'NVIDIA Corporation. Downloaded for compatible NVIDIA GPU speech engines.'
      }
    ]
  return []
}
