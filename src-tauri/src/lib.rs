mod editor;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            editor::open(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Driveby");
}
