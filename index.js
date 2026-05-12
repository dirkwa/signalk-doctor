module.exports = function (app) {
  const plugin = {
    id: 'signalk-doctor',
    name: 'SignalK Doctor',
    description: 'Diagnostic and health-check plugin for SignalK (skeleton).',
    schema: {
      type: 'object',
      properties: {}
    },
    start: function (_options) {
      app.debug('signalk-doctor start (skeleton — no checks implemented)');
    },
    stop: function () {
      app.debug('signalk-doctor stop');
    }
  };

  return plugin;
};
