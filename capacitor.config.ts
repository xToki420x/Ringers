import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.ringers.horseshoes',
  appName: 'Ringers',
  webDir: 'dist',
  backgroundColor: '#0d1117',
  ios: { contentInset: 'never' },
  android: { allowMixedContent: false },
};

export default config;
