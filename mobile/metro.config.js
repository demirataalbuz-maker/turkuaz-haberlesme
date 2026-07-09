const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')

// bare-pack çıktısı .mjs bundle'ı asset olarak taşınabilsin diye .mjs uzantısını ekle.
const config = {
  resolver: {
    assetExts: ['mjs', 'bundle']
  }
}

module.exports = mergeConfig(getDefaultConfig(__dirname), config)
