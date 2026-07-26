import { Type, type Static } from '@sinclair/typebox';

export const ConfigSchema = Type.Object({
  managedContainer: Type.Boolean({
    default: false,
    title: 'Manage the updater container from this plugin',
    description:
      'If true, the plugin will attempt to ensureRunning the updater container. ' +
      'Default false — the bash installer starts the container as a systemd Quadlet, ' +
      'and that path is what survives plugin failures. Set to true only if you understand ' +
      "what you're doing.",
  }),
  logLevel: Type.Union([Type.Literal('error'), Type.Literal('info'), Type.Literal('debug')], {
    default: 'info',
    title: 'Log level',
  }),
  publishNotifications: Type.Boolean({
    default: true,
    title: 'Publish health-probe notifications',
    description:
      'Poll the doctor engine and republish its warn/fail health probes as ' +
      'SignalK notifications under notifications.doctor.<probe-id>, so alarm ' +
      'panels (KIP, etc.) surface them. Cleared (state: normal) when a probe ' +
      'recovers. Disable to keep probe results confined to the doctor console.',
  }),
  notificationIntervalSeconds: Type.Number({
    default: 60,
    minimum: 10,
    maximum: 3600,
    title: 'Notification poll interval (seconds)',
    description:
      'How often to poll the doctor engine for probe status. 10s–3600s. ' +
      'Only used when "Publish health-probe notifications" is on.',
  }),
});

export type Config = Static<typeof ConfigSchema>;

export const SCHEMA_DEFAULTS: Config = {
  managedContainer: false,
  logLevel: 'info',
  publishNotifications: true,
  notificationIntervalSeconds: 60,
};
