// Builds the Admin UI config panel (src/configpanel) into public/ as a
// webpack Module Federation remote — the standard Signal K
// "signalk-plugin-configurator" panel build. (.cjs because the package
// itself is ESM.)
//
// Unlike the CommonJS reference plugins (signalk-grafana/-questdb), this
// package has `"type": "module"`, and the server keys the injected script
// tag off that field: the panel is loaded as `<script type="module">` and
// the Admin UI expects an ESM federation container (`import()` +
// get/init exports). A classic `var` remote loads silently into module
// scope and the panel dies with "Module is not available" — hence
// outputModule + library type "module" below.
//
// `clean: false` matters doubly here: public/ also carries the hand-written
// webapp (index.html, app.js, …), which a cleaning build would delete.
const path = require("path");
const { ModuleFederationPlugin } = require("webpack").container;
const packageJson = require("./package.json");

module.exports = {
  entry: "./src/configpanel/index",
  mode: "production",
  experiments: { outputModule: true },
  output: {
    path: path.resolve(__dirname, "public"),
    module: true,
    clean: false,
  },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        loader: "babel-loader",
        exclude: /node_modules/,
        options: { presets: ["@babel/preset-react"] },
      },
    ],
  },
  resolve: {
    extensions: [".js", ".jsx"],
  },
  plugins: [
    new ModuleFederationPlugin({
      name: packageJson.name.replace(/[-@/]/g, "_"),
      library: { type: "module" },
      filename: "remoteEntry.js",
      exposes: {
        "./PluginConfigurationPanel":
          "./src/configpanel/PluginConfigurationPanel",
      },
      shared: {
        react: { singleton: true, requiredVersion: "^19" },
        "react-dom": { singleton: true, requiredVersion: "^19" },
      },
    }),
  ],
};
