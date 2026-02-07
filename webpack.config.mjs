// webpack.config.mjs
import path from "path";
import { fileURLToPath } from "url";
import nodeExternals from "webpack-node-externals";
import CopyPlugin from "copy-webpack-plugin";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  entry: "./index.js",
  target: "node",
  mode: "production",
  externals: [nodeExternals()],
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "server.cjs", // Change this
    libraryTarget: "commonjs2",
  },

  plugins: [
    new CopyPlugin({
      patterns: [
        { from: ".env", to: ".env" },
        // Do NOT copy package.json with "type": "module"
      ],
    }),
  ],
};
