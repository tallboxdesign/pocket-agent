import { contextBridge, ipcRenderer } from 'electron';

// Minimal API for splash screen - only exposes what's needed
contextBridge.exposeInMainWorld('splash', {
  complete: () => ipcRenderer.send('splash-complete'),
});

declare global {
  interface Window {
    splash: {
      complete: () => void;
    };
  }
}
