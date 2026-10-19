// The service worker's only job in M1: open the side panel when the toolbar
// icon is clicked. The agent itself lives in the side panel, because MV3
// service workers are shut down after ~30s idle, which would kill an agent
// that is waiting for the user to approve an action.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
