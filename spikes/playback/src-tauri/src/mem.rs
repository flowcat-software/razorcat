//! Memory of this process and everything under it (WebView2's browser, renderer and GPU
//! processes, and ffmpeg), by executable name.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::{
    GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    /// Private bytes, MB, summed over the tree.
    pub private_mb: f64,
    pub working_set_mb: f64,
    pub by_exe: BTreeMap<String, f64>,
    pub processes: usize,
}

pub fn measure() -> Memory {
    let mut m = Memory::default();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return m;
        };
        let mut procs: Vec<(u32, u32, String)> = vec![];
        let mut e = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
                let name = String::from_utf16_lossy(&e.szExeFile[..len]);
                procs.push((e.th32ProcessID, e.th32ParentProcessID, name));
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);

        let mut children: HashMap<u32, Vec<usize>> = HashMap::new();
        for (i, p) in procs.iter().enumerate() {
            children.entry(p.1).or_default().push(i);
        }
        let mut stack = vec![std::process::id()];
        let mut tree = vec![];
        while let Some(pid) = stack.pop() {
            tree.push(pid);
            for &i in children.get(&pid).into_iter().flatten() {
                if procs[i].0 != pid {
                    stack.push(procs[i].0);
                }
            }
        }
        for pid in tree {
            let name = procs
                .iter()
                .find(|p| p.0 == pid)
                .map_or("?".into(), |p| p.2.clone());
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                continue;
            };
            let mut c = PROCESS_MEMORY_COUNTERS_EX {
                cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
                ..Default::default()
            };
            if GetProcessMemoryInfo(h, &mut c as *mut _ as *mut PROCESS_MEMORY_COUNTERS, c.cb)
                .is_ok()
            {
                let private = c.PrivateUsage as f64 / 1048576.0;
                m.private_mb += private;
                m.working_set_mb += c.WorkingSetSize as f64 / 1048576.0;
                *m.by_exe.entry(name).or_default() += private;
                m.processes += 1;
            }
            let _ = CloseHandle(h);
        }
    }
    m
}
