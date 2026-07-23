module.exports = function (app) {
  const plugin = {
    id: 'signalk-wyoming',
    name: 'Wyoming Voice Assistant',
    description:
      'Wyoming protocol voice assistant orchestrator for Signal K — pre-release placeholder, not yet functional.',

    schema: () => ({
      type: 'object',
      properties: {},
    }),

    start: (options) => {
      app.setPluginStatus(
        'Pre-release placeholder — not yet functional. See https://github.com/hoeken/signalk-wyoming'
      )
    },

    stop: () => {},
  }

  return plugin
}
