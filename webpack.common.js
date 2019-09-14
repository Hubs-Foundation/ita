const webpack = require("webpack");
const path = require("path");
const CopyWebpackPlugin = require("copy-webpack-plugin");

module.exports = {
  entry: path.join(__dirname, "src", "app"),
  module: {
    rules: [
      {
        test: /.js$/,
        include: [path.resolve(__dirname, "src")],
        exclude: [path.resolve(__dirname, "node_modules")],
        loader: "babel-loader"
      }
    ]
  },
  resolve: {
    extensions: [".js"]
  },
  stats: {
    warningsFilter: warning => {
      // Critical dependency error, can ignore since we don't use views
      return RegExp("node_modules/express/lib/view.js").test(warning);
    }
  },
  // Don't use native PostgreSQL driver
  plugins: [
    new webpack.IgnorePlugin(/^pg-native$/),

    new CopyWebpackPlugin([
      {
        from: "schemas",
        to: "schemas"
      }
    ])
  ]
};
