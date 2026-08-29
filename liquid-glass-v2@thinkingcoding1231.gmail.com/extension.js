import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';

export default class LiquidGlassExtension extends Extension {
  async enable() {
    console.log(`[Liquid Glass] Enabled. UUID: ${this.uuid}`);

    this._enabled = true;
    this._quickSettingsTimeoutId = 0;
    this._timeoutId = 0;
    this._reconnectTimeoutId = 0;
    this._dashDestroyId = 0;

    this._settings = this.getSettings("org.gnome.shell.extensions.liquid-glass-v2@thinkingcoding1231.gmail.com");

    const moduleVersion = Date.now();
    const distUri = `${this.dir.get_uri()}/dist`;
    const [
      { UIManager },
      { DashManager },
      { NotificationManager },
      { QuickSettingsManager },
      { OsdManager },
    ] = await Promise.all([
      import(`${distUri}/uiManager.js?v=${moduleVersion}`),
      import(`${distUri}/dockManager.js?v=${moduleVersion}`),
      import(`${distUri}/notificationManager.js?v=${moduleVersion}`),
      import(`${distUri}/quickSettingsManager.js?v=${moduleVersion}`),
      import(`${distUri}/osdManager.js?v=${moduleVersion}`),
    ]);

    if (!this._enabled) return;

    this._DashManager = DashManager;
    this._QuickSettingsManager = QuickSettingsManager;

    // Initialize liquid glass for panel dropdown menus.
    this._uiManagers = [];
    for (const [name, panelItem] of Object.entries(Main.panel?.statusArea ?? {})) {
      if (name === 'quickSettings') continue;
      if (!panelItem?.menu?.actor || !panelItem?.menu?.box) continue;

      try {
        const manager = new UIManager(this.dir.get_path(), this._settings, panelItem);
        manager.setup();
        this._uiManagers.push(manager);
      } catch (e) {
        console.log(`[Liquid Glass] Failed to initialize panel menu ${name}: ${e}`);
      }
    }

    // Initialize the notification manager to apply effects to notifications
    this._notificationManager = new NotificationManager(this.dir.get_path(), this._settings);
    this._notificationManager.setup();

    // Initialize the OSD manager to apply effects to on-screen displays (like volume changes)
    this._osdManager = new OsdManager(this.dir.get_path(), this._settings);
    this._osdManager.setup();

    const findQuickSettings = () => {
      if (Main.panel?.statusArea?.quickSettings) {
        this._quickSettingsManager = new this._QuickSettingsManager(this.dir.get_path(), this._settings);
        this._quickSettingsManager.setup();

        // ---------------------------------------------------------
        // TARGET EXECUTION STRATEGY FOR QUICK TOGGLES
        // ---------------------------------------------------------
        try {
            let qsMenu = Main.panel.statusArea.quickSettings.menu;
            if (qsMenu && qsMenu.box && qsMenu.box.get_children().length > 0) {
                // Access the master Quick Settings Grid container layout
                let grid = qsMenu.box.get_children()[0];
                if (grid && grid.get_children) {
                    let toggles = grid.get_children();
                    for (let i = 0; i < toggles.length; i++) {
                        let toggle = toggles[i];
                        // Drill down directly into the instance's private properties
                        if (toggle._separator) {
                            toggle._separator.hide();
                            toggle._separator.visible = false;
                        }
                        if (toggle._customToggle) {
                            toggle._customToggle.hide();
                            toggle._customToggle.visible = false;
                        }
                    }
                }
            }
        } catch(e) {
            console.error("[Liquid Glass] Failed to apply toggle hiding strategy: " + e);
        }

        return true;
      }
      return false;
    };

    if (findQuickSettings()) {
      this._quickSettingsTimeoutId = 0;
    } else {
      this._quickSettingsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
        if (!this._enabled) {
          this._quickSettingsTimeoutId = 0;
          return GLib.SOURCE_REMOVE;
        }

        let isFound = findQuickSettings();
        if (isFound) {
          this._quickSettingsTimeoutId = 0;
          return GLib.SOURCE_REMOVE;
        }

        return GLib.SOURCE_CONTINUE;
      });
    }

    // Dash to Dock might not be fully loaded when this extension is enabled at startup.
    // We set a 2-second (2000ms) delay before searching for its UI container.
    let dashSearchAttempts = 0;
    this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
      if (!this._enabled) {
        this._timeoutId = 0;
        return GLib.SOURCE_REMOVE;
      }

      let isFound = this._findDashToDock();

      if (isFound) {
        // Reset the ID after execution
        this._timeoutId = 0;
        return GLib.SOURCE_REMOVE;
      }

      // Give up after ~30s so we don't run a full uiGroup recursive scan every
      // 2s forever when Dash to Dock isn't installed.
      if (++dashSearchAttempts >= 15) {
        this._timeoutId = 0;
        return GLib.SOURCE_REMOVE;
      }

      // Return SOURCE_CONTINUE to poll every 2 seconds until it finds Dash to Dock
      return GLib.SOURCE_CONTINUE;
    });
  }

  _findDashToDock() {
    // A helper function to recursively search the GNOME UI tree for a specific actor name
    const findActorByName = (actor, name) => {
      if (actor.get_name && actor.get_name() === name) {
        return actor;
      }

      // Traverse through all children elements
      let children = actor.get_children();
      for (let i = 0; i < children.length; i++) {
        let found = findActorByName(children[i], name);
        if (found) return found;
      }
      return null;
    };

    // Search the entire GNOME UI group for the main Dash to Dock container
    let dashContainer = findActorByName(Main.layoutManager.uiGroup, 'dashtodockDashContainer') ||
                        findActorByName(Main.layoutManager.uiGroup, 'dashtodockContainer');

    if (dashContainer) {
      console.log("[Liquid Glass] Found Dash to Dock container!");

      // Initialize the dock manager and apply the liquid glass effect
      this._dashManager = new this._DashManager(this.dir.get_path(), dashContainer, this._settings);
      this._dashManager.setup();

      this._dashDestroyId = dashContainer.connect('destroy', () => {
        console.log("[Liquid Glass] Dash to Dock container destroyed (settings changed?). Restarting search...");
        this._dashDestroyId = 0; // Reset the destroy signal ID since the container is gone

        // Cleanup the existing Dash manager to avoid memory leaks or orphaned actors
        if (this._dashManager) {
          this._dashManager.cleanup();
          this._dashManager = null;
        }

        // Clear any existing reconnect timeout to prevent multiple timers from stacking up
        if (this._reconnectTimeoutId !== 0) {
          GLib.Source.remove(this._reconnectTimeoutId);
        }

        // Set a short delay before trying to find Dash to Dock again, as it might be reloaded shortly after being destroyed
        this._reconnectTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
          // Try to find Dash to Dock again after the delay. If it's found, the timer will be removed. If not, it will continue to check every 2 seconds until it is found.
          if (!this._enabled) {
            this._reconnectTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
          }
          let isFound = this._findDashToDock();

          if (isFound) {
            // If found, reset the timeout ID and remove the timer
            this._reconnectTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
          }

          // If not found, continue the loop and check again in 2 seconds
          return GLib.SOURCE_CONTINUE;
        });

        return true; // Return true to indicate that the signal was handled
      });
      return true;

    } else {
      // Note: If it's still not found, the user might not have Dash to Dock installed,
      // or it requires a more complex monitoring system to detect late loads.
      console.log("[Liquid Glass] Dash to Dock was not found.");
      return false; // Return false to indicate that Dash to Dock was not found
    }
  }

  disable() {
    console.log(`[Liquid Glass] Disabling...`);

    this._enabled = false;

    // ---------------------------------------------------------
    // RESTORE QUICK TOGGLES
    // ---------------------------------------------------------
    try {
        let qsMenu = Main.panel.statusArea.quickSettings.menu;
        if (qsMenu && qsMenu.box && qsMenu.box.get_children().length > 0) {
            let grid = qsMenu.box.get_children()[0];
            if (grid && grid.get_children) {
                let toggles = grid.get_children();
                for (let i = 0; i < toggles.length; i++) {
                    let toggle = toggles[i];
                    if (toggle._separator) {
                        toggle._separator.visible = true;
                        toggle._separator.show();
                    }
                    if (toggle._customToggle) {
                        toggle._customToggle.visible = true;
                        toggle._customToggle.show();
                    }
                }
            }
        }
    } catch(e) {}

    if (this._quickSettingsTimeoutId && this._quickSettingsTimeoutId !== 0) {
      GLib.Source.remove(this._quickSettingsTimeoutId);
      this._quickSettingsTimeoutId = 0;
    }

    // Clear any pending timeouts to prevent them from executing after the extension is disabled
    if (this._timeoutId !== 0) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = 0;
    }

    if (this._reconnectTimeoutId !== 0) {
      GLib.Source.remove(this._reconnectTimeoutId);
      this._reconnectTimeoutId = 0;
    }

    // Crucial: Always restore the UI to its original state when the extension is disabled
    // Failing to clean up can result in invisible menus or memory leaks
    if (this._uiManagers) {
      for (const manager of this._uiManagers) {
        try {
          manager.cleanup();
        } catch (e) { }
      }
      this._uiManagers = [];
    }

    if (this._quickSettingsManager) {
      this._quickSettingsManager.cleanup();
      this._quickSettingsManager = null;
    }

    if (this._dashManager) {
      // Disconnect the destroy signal if it was connected
      if (this._dashDestroyId !== 0 && this._dashManager.targetActor) {
        // ---> WRAP THIS IN A TRY-CATCH <---
        try {
          this._dashManager.targetActor.disconnect(this._dashDestroyId);
        } catch (e) { }
        this._dashDestroyId = 0;
      }
      this._dashManager.cleanup();
      this._dashManager = null;
    }

    if (this._notificationManager) {
      this._notificationManager.cleanup();
      this._notificationManager = null;
    }

    if (this._osdManager) {
      this._osdManager.cleanup();
      this._osdManager = null;
    }
  }
}
