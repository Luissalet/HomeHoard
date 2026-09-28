module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // react-native-reanimated/plugin DEBE ir el último.
    plugins: ['react-native-reanimated/plugin'],
  };
};
