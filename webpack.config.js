const webpack = require('webpack');
const path = require('path');
const nodeExternals = require('webpack-node-externals');

module.exports = {
  entry: './bin/server',
  target: 'node',
  output: {
    path: path.join(__dirname, 'dist'),
    filename: 'ita.js'
  },

  // we can't bundle all the deps because they include binaries, e.g. pg-native,
  // so we just ship the node_modules directory intact
  externals: [nodeExternals()]
};
