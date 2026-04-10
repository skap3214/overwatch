const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

// Prevent Metro from resolving modules from the parent directory
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
];

module.exports = withNativeWind(config, {
  input: "./global.css",
  inlineRem: 16,
});
