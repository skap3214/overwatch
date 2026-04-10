Pod::Spec.new do |s|
  s.name           = 'StreamingAudio'
  s.version        = '0.1.0'
  s.summary        = 'Streaming PCM audio playback for read-aloud'
  s.description    = 'Expo native module for streaming PCM audio playback via AVAudioEngine'
  s.license        = 'MIT'
  s.author         = 'YouLearn'
  s.homepage       = 'https://youlearn.ai'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
