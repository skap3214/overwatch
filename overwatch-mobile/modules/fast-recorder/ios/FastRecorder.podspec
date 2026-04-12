Pod::Spec.new do |s|
  s.name           = 'FastRecorder'
  s.version        = '0.1.0'
  s.summary        = 'Fast push-to-talk audio recorder'
  s.description    = 'Expo native module with pre-allocated AVAudioRecorder for instant recording start'
  s.license        = 'MIT'
  s.author         = 'Overwatch'
  s.homepage       = 'https://github.com/skap3214/overwatch'
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
