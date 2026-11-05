//! Scribe's name and icon in the Windows volume mixer (#1013).
//!
//! WebView2 plays sound from its own audio process (msedgewebview2.exe, a grandchild of this
//! one), so Windows lists it as "Microsoft Edge WebView2", one slider per process. This thread
//! finds the output sessions of processes that descend from Scribe and gives them Scribe's name,
//! icon, and one grouping id, so the mixer shows a single "Scribe" slider. Windows lets another
//! process change these labels; it runs when Scribe starts and whenever a session or an output
//! device appears.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Sender};

use windows::core::{implement, Interface, GUID, HSTRING, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, PROPERTYKEY};
use windows::Win32::Media::Audio::{
    eRender, EDataFlow, ERole, IAudioSessionControl, IAudioSessionControl2,
    IAudioSessionManager2, IAudioSessionNotification, IAudioSessionNotification_Impl,
    IMMDeviceEnumerator, IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator,
    DEVICE_STATE, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

const NAME: &str = "Scribe";
/// Shared by every Scribe session, so the mixer shows them as one slider.
const GROUP: GUID = GUID::from_u128(0x6b2f_5c1e_93a4_4d7b_8e21_5c0a_1f3d_9b47);

#[implement(IAudioSessionNotification)]
struct SessionCreated(Sender<()>);

impl IAudioSessionNotification_Impl for SessionCreated_Impl {
    fn OnSessionCreated(&self, _session: windows::core::Ref<IAudioSessionControl>) -> windows::core::Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
}

#[implement(IMMNotificationClient)]
struct DeviceChanged(Sender<()>);

impl IMMNotificationClient_Impl for DeviceChanged_Impl {
    fn OnDeviceStateChanged(&self, _id: &PCWSTR, _state: DEVICE_STATE) -> windows::core::Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
    fn OnDeviceAdded(&self, _id: &PCWSTR) -> windows::core::Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
    fn OnDeviceRemoved(&self, _id: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnDefaultDeviceChanged(&self, _flow: EDataFlow, _role: ERole, _id: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnPropertyValueChanged(&self, _id: &PCWSTR, _key: &PROPERTYKEY) -> windows::core::Result<()> {
        Ok(())
    }
}

pub fn start() {
    let _ = std::thread::Builder::new()
        .name("audio-sessions".into())
        .spawn(|| {
            if let Err(err) = run() {
                eprintln!("Volume mixer labels are off: {err}");
            }
        });
}

fn run() -> windows::core::Result<()> {
    // Session notifications must be registered from a multithreaded apartment.
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
    let icon = std::env::current_exe()
        .map(|exe| HSTRING::from(format!("{},0", exe.display())))
        .unwrap_or_default();
    let (tx, rx) = channel();
    let devices: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
    let device_client: IMMNotificationClient = DeviceChanged(tx.clone()).into();
    unsafe { devices.RegisterEndpointNotificationCallback(&device_client)? };
    let session_client: IAudioSessionNotification = SessionCreated(tx).into();
    // Session managers by device id; kept so their notifications stay registered.
    let mut managers: HashMap<String, IAudioSessionManager2> = HashMap::new();
    loop {
        if let Err(err) = pass(&devices, &session_client, &mut managers, &icon) {
            eprintln!("Volume mixer labels: {err}");
        }
        if rx.recv().is_err() {
            return Ok(());
        }
        // A burst of notifications needs one pass.
        while rx.try_recv().is_ok() {}
    }
}

/// Registers for sessions on new output devices and labels Scribe's sessions on all of them.
fn pass(
    devices: &IMMDeviceEnumerator,
    client: &IAudioSessionNotification,
    managers: &mut HashMap<String, IAudioSessionManager2>,
    icon: &HSTRING,
) -> windows::core::Result<()> {
    let parents = parent_map();
    let me = std::process::id();
    let endpoints = unsafe { devices.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)? };
    for i in 0..unsafe { endpoints.GetCount()? } {
        let device = unsafe { endpoints.Item(i)? };
        let id = unsafe { device.GetId()?.to_string().unwrap_or_default() };
        let fresh = !managers.contains_key(&id);
        if fresh {
            let manager: IAudioSessionManager2 = unsafe { device.Activate(CLSCTX_ALL, None)? };
            managers.insert(id.clone(), manager);
        }
        let manager = &managers[&id];
        // Enumerating first is what makes the manager start sending notifications.
        let sessions = unsafe { manager.GetSessionEnumerator()? };
        if fresh {
            unsafe { manager.RegisterSessionNotification(client)? };
        }
        for j in 0..unsafe { sessions.GetCount()? } {
            let Ok(session) = (unsafe { sessions.GetSession(j) }) else { continue };
            let Ok(session) = session.cast::<IAudioSessionControl2>() else { continue };
            let Ok(pid) = (unsafe { session.GetProcessId() }) else { continue };
            if pid != me && descends_from(pid, me, &parents) {
                label(&session, icon);
            }
        }
    }
    Ok(())
}

fn label(session: &IAudioSessionControl2, icon: &HSTRING) {
    let context = GUID::zeroed();
    unsafe {
        let named = session.GetDisplayName().map(|name| name.to_string().unwrap_or_default() == NAME);
        if !matches!(named, Ok(true)) {
            let _ = session.SetDisplayName(&HSTRING::from(NAME), &context);
        }
        if !icon.is_empty() {
            let current = session.GetIconPath().map(|path| path.to_string().unwrap_or_default());
            if current.ok().as_deref() != Some(&icon.to_string_lossy()) {
                let _ = session.SetIconPath(icon, &context);
            }
        }
        if session.GetGroupingParam().ok() != Some(GROUP) {
            let _ = session.SetGroupingParam(&GROUP, &context);
        }
    }
}

/// Process id to parent id, for every running process.
fn parent_map() -> HashMap<u32, u32> {
    let mut parents = HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return parents };
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    parents
}

/// WebView2's audio process is a child of its browser process, which is a child of Scribe.
fn descends_from(pid: u32, ancestor: u32, parents: &HashMap<u32, u32>) -> bool {
    let mut current = pid;
    for _ in 0..4 {
        match parents.get(&current) {
            Some(&parent) if parent == ancestor => return true,
            Some(&parent) if parent != 0 && parent != current => current = parent,
            _ => return false,
        }
    }
    false
}
