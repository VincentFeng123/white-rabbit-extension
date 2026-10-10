// White Rabbit Helper: brings Safari into White Rabbit on a Mac.
//
// Safari won't let a secure web page talk to an app on the same computer, and
// extensions for it come only from the App Store, so this small app does the
// capturing instead. While it runs (a rabbit in the menu bar), it reads new
// visits from Safari's own history database every few minutes and sends them
// to the person's White Rabbit account, where only they can see them. The
// server applies their never-analyze rules before anything is stored.
//
// Safari's history has no Private Browsing in it (Safari doesn't keep it),
// and includes pages from the person's iPhone and iPad when Safari syncs
// through iCloud. Reading it needs Full Disk Access, which macOS asks the
// person to grant in System Settings. It starts at login only if the person
// turns on Open at Login in its menu.
//
//   WhiteRabbitHelper pair <origin> <code>   trade a pairing code for a device token
//   WhiteRabbitHelper sync-once              one sync, printed (for testing)
//   WhiteRabbitHelper forget-login           turn off Open at Login (the uninstaller runs this)
//   WhiteRabbitHelper                        the menu bar app
//
// Build with helper/build.sh. A release build talks only to White Rabbit's
// own site and reads only Safari's own history: anything else running on this
// Mac can write its config file and its environment, and none of it may point
// what it reads with Full Disk Access somewhere else. DEBUG=1 helper/build.sh
// makes a development build that takes any address and the overrides below.

import AppKit
import Foundation
import ServiceManagement
import SQLite3

let helperVersion = "1.0.0"
let env = ProcessInfo.processInfo.environment

// MARK: - Where things live

/** The only White Rabbit a release build pairs with or sends to. */
let productionOrigin = "https://www.whiterabbt.com"

func allowedOrigin(_ origin: String) -> Bool {
    #if DEBUG
    return true
    #else
    return origin == productionOrigin
    #endif
}

/** Development-only overrides. A release build ignores them. */
func override(_ name: String) -> String? {
    #if DEBUG
    return env[name]
    #else
    return nil
    #endif
}

enum Paths {
    static let home = FileManager.default.homeDirectoryForCurrentUser
    static var support: URL {
        override("WHITE_RABBIT_HELPER_DIR").map { URL(fileURLWithPath: $0) }
            ?? home.appendingPathComponent("Library/Application Support/White Rabbit Helper")
    }
    static var config: URL { support.appendingPathComponent("config.json") }
    static var history: URL {
        override("WHITE_RABBIT_SAFARI_HISTORY").map { URL(fileURLWithPath: $0) }
            ?? home.appendingPathComponent("Library/Safari/History.db")
    }
    /** This user's own temporary folder, as macOS assigns it; TMPDIR can't move it. */
    static var temporary: URL {
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        if confstr(_CS_DARWIN_USER_TEMP_DIR, &buffer, buffer.count) > 0 {
            return URL(fileURLWithPath: String(cString: buffer), isDirectory: true)
        }
        return FileManager.default.temporaryDirectory
    }
}

struct Config: Codable {
    var origin: String
    var token: String
    /** The last Safari visit (history_visits.id) already sent. */
    var cursor: Int64
}

func loadConfig() -> Config? {
    guard let data = try? Data(contentsOf: Paths.config) else { return nil }
    return try? JSONDecoder().decode(Config.self, from: data)
}

func saveConfig(_ config: Config) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: Paths.support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try JSONEncoder().encode(config).write(to: Paths.config, options: .atomic)
    // The token only lets it add pages to this person's captures; still, only they may read it.
    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Paths.config.path)
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n".utf8))
}

// MARK: - Talking to White Rabbit

func postJSON(_ url: URL, token: String?, body: [String: Any]) async throws -> (Int, [String: Any]) {
    var request = URLRequest(url: url, timeoutInterval: 60)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("WhiteRabbitHelper/\(helperVersion)", forHTTPHeaderField: "User-Agent")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, response) = try await URLSession.shared.data(for: request)
    let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    return ((response as? HTTPURLResponse)?.statusCode ?? 0, json)
}

// MARK: - Safari's history

enum HistoryError: Error {
    case noAccess
    case missing
    case failed(String)
}

struct Visit {
    let id: Int64
    let url: String
    let title: String?
    /** Seconds since 2001-01-01, as Safari stores it. */
    let time: Double
}

/**
 * A visit's address as it's sent: without the part after # (where sign-in flows hand back tokens)
 * and without a name or password before the host. White Rabbit cleans the rest, such as tokens
 * and keys in the query, before anything is kept (src/lib/capture/clean-url.ts).
 */
func sendable(_ address: String) -> String {
    let base = address.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? address
    guard var parts = URLComponents(string: base), parts.user != nil || parts.password != nil else { return base }
    parts.user = nil
    parts.password = nil
    return parts.string ?? base
}

func columns(_ db: OpaquePointer?, _ table: String) -> Set<String> {
    var stmt: OpaquePointer?
    var out = Set<String>()
    guard sqlite3_prepare_v2(db, "PRAGMA table_info(\(table))", -1, &stmt, nil) == SQLITE_OK else { return out }
    defer { sqlite3_finalize(stmt) }
    while sqlite3_step(stmt) == SQLITE_ROW {
        if let name = sqlite3_column_text(stmt, 1) { out.insert(String(cString: name)) }
    }
    return out
}

/** Visits after `cursor` and no older than `since`, oldest first. */
func readVisits(after cursor: Int64, since: Double, limit: Int) throws -> [Visit] {
    let path = Paths.history.path
    // Without Full Disk Access, macOS refuses to open anything in ~/Library/Safari.
    let fd = open(path, O_RDONLY)
    if fd < 0 {
        switch errno {
        case EPERM, EACCES: throw HistoryError.noAccess
        case ENOENT: throw HistoryError.missing
        default: throw HistoryError.failed(String(cString: strerror(errno)))
        }
    }
    close(fd)

    // Safari keeps its database open; read a copy so its locks are never touched.
    let fm = FileManager.default
    let tmp = Paths.temporary.appendingPathComponent("white-rabbit-\(UUID().uuidString)", isDirectory: true)
    try fm.createDirectory(at: tmp, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? fm.removeItem(at: tmp) }
    let copy = tmp.appendingPathComponent("History.db")
    for suffix in ["", "-wal", "-shm"] where fm.fileExists(atPath: path + suffix) {
        try fm.copyItem(atPath: path + suffix, toPath: copy.path + suffix)
    }

    var db: OpaquePointer?
    guard sqlite3_open_v2(copy.path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
        defer { sqlite3_close(db) }
        throw HistoryError.failed(String(cString: sqlite3_errmsg(db)))
    }
    defer { sqlite3_close(db) }

    // Safari has changed this schema before; use only the columns that are there.
    let have = columns(db, "history_visits")
    var filters = ["v.id > ?1", "v.visit_time >= ?2"]
    if have.contains("load_successful") { filters.append("v.load_successful = 1") }
    if have.contains("redirect_destination") { filters.append("v.redirect_destination IS NULL") }
    if have.contains("http_non_get") { filters.append("v.http_non_get = 0") }
    let sql = """
        SELECT v.id, i.url, v.title, v.visit_time
        FROM history_visits v JOIN history_items i ON i.id = v.history_item
        WHERE \(filters.joined(separator: " AND "))
        ORDER BY v.id LIMIT ?3
        """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
        throw HistoryError.failed(String(cString: sqlite3_errmsg(db)))
    }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int64(stmt, 1, cursor)
    sqlite3_bind_double(stmt, 2, since)
    sqlite3_bind_int(stmt, 3, Int32(limit))

    var visits: [Visit] = []
    while sqlite3_step(stmt) == SQLITE_ROW {
        guard let url = sqlite3_column_text(stmt, 1) else { continue }
        let title = sqlite3_column_text(stmt, 2).map { String(cString: $0) }
        visits.append(Visit(
            id: sqlite3_column_int64(stmt, 0),
            url: String(cString: url),
            title: title,
            time: sqlite3_column_double(stmt, 3)
        ))
    }
    return visits
}

// MARK: - Syncing

enum SyncStatus: Equatable {
    case notPaired
    case watching
    case needsAccess
    case disconnected
    case offline
    case noSafari
}

let isoFormatter = ISO8601DateFormatter()
let batchSize = 1000

final class Syncer {
    private var lastReport = Date.distantPast
    private var lastAccess: Bool?

    /** Sends every visit Safari recorded since the last sync, then reports in. */
    func syncOnce() async -> (SyncStatus, Int) {
        guard var config = loadConfig(), allowedOrigin(config.origin), let base = URL(string: config.origin) else {
            return (.notPaired, 0)
        }
        let ingest = base.appendingPathComponent("api/safari-helper/ingest")
        let weekAgo = Date().timeIntervalSinceReferenceDate - 7 * 86_400
        var sent = 0
        do {
            while true {
                let visits = try readVisits(after: config.cursor, since: weekAgo, limit: batchSize)
                if visits.isEmpty { break }
                let pages: [[String: Any]] = visits.compactMap { v in
                    guard v.url.hasPrefix("http://") || v.url.hasPrefix("https://") else { return nil }
                    return [
                        "id": "sf_\(v.id)",
                        "url": String(sendable(v.url).prefix(2000)),
                        "title": String((v.title ?? "").prefix(400)),
                        "at": isoFormatter.string(from: Date(timeIntervalSinceReferenceDate: v.time)),
                    ]
                }
                let (code, _) = try await postJSON(
                    ingest, token: config.token,
                    body: ["version": helperVersion, "access": true, "pages": pages]
                )
                if code == 401 { return (.disconnected, sent) }
                guard code == 200 else { return (.offline, sent) }
                config.cursor = visits[visits.count - 1].id
                try saveConfig(config)
                sent += pages.count
                lastReport = Date()
                lastAccess = true
                if visits.count < batchSize { break }
            }
            // Nothing new: still check in now and then, so White Rabbit knows it's running.
            if sent == 0, try await report(access: true, to: ingest, token: config.token) == 401 {
                return (.disconnected, 0)
            }
            return (.watching, sent)
        } catch HistoryError.noAccess {
            let code = try? await report(access: false, to: ingest, token: config.token)
            return (code == 401 ? .disconnected : .needsAccess, 0)
        } catch HistoryError.missing {
            return (.noSafari, 0)
        } catch {
            log("sync failed: \(error)")
            return (.offline, sent)
        }
    }

    /** A check-in with no pages, at most every 15 minutes unless access changed. */
    private func report(access: Bool, to url: URL, token: String) async throws -> Int {
        if lastAccess == access && Date().timeIntervalSince(lastReport) < 15 * 60 { return 200 }
        let (code, _) = try await postJSON(url, token: token, body: ["version": helperVersion, "access": access, "pages": []])
        if code == 200 {
            lastReport = Date()
            lastAccess = access
        }
        return code
    }
}

// MARK: - Commands

func pair(origin: String, code: String) async -> Int32 {
    let origin = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard allowedOrigin(origin), let base = URL(string: origin), base.scheme == "https" || base.host == "localhost" else {
        print("This White Rabbit Helper connects only to \(productionOrigin). For another address, build it with DEBUG=1 helper/build.sh.")
        return 1
    }
    do {
        let (status, json) = try await postJSON(
            base.appendingPathComponent("api/safari-helper/claim"), token: nil, body: ["code": code]
        )
        guard status == 200, let token = json["token"] as? String else {
            print(status == 401
                ? "That pairing code has expired or was already replaced. Copy the command from White Rabbit again."
                : "White Rabbit couldn't pair this Mac (\(status)). Try again.")
            return 1
        }
        try saveConfig(Config(origin: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), token: token, cursor: 0))
        print("Paired with \(origin).")
        return 0
    } catch {
        print("Couldn't reach White Rabbit: \(error.localizedDescription)")
        return 1
    }
}

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "pair" {
    guard args.count == 4 else {
        print("usage: WhiteRabbitHelper pair <origin> <code>")
        exit(2)
    }
    let semaphore = DispatchSemaphore(value: 0)
    var code: Int32 = 1
    Task {
        code = await pair(origin: args[2], code: args[3])
        semaphore.signal()
    }
    semaphore.wait()
    exit(code)
}
if args.count >= 2 && args[1] == "forget-login" {
    if SMAppService.mainApp.status == .enabled { try? SMAppService.mainApp.unregister() }
    exit(0)
}
if args.count >= 2 && args[1] == "sync-once" {
    let semaphore = DispatchSemaphore(value: 0)
    Task {
        let (status, sent) = await Syncer().syncOnce()
        print("\(status) sent=\(sent) cursor=\(loadConfig()?.cursor ?? -1)")
        semaphore.signal()
    }
    semaphore.wait()
    exit(0)
}

// MARK: - The menu bar app

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let syncer = Syncer()
    private var item: NSStatusItem!
    private let statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    private let allowAccess = NSMenuItem(title: "Allow in System Settings…", action: #selector(openAccessSettings), keyEquivalent: "")
    private let openAtLogin = NSMenuItem(title: "Open at Login", action: #selector(toggleOpenAtLogin), keyEquivalent: "")
    private var timer: Timer?
    private var status: SyncStatus = .watching
    private var lastSync: Date?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // One at a time.
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if !others.isEmpty {
            NSApp.terminate(nil)
            return
        }

        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = rabbitMark()
        let menu = NSMenu()
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(allowAccess)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Open White Rabbit", action: #selector(openWhiteRabbit), keyEquivalent: "")
        menu.addItem(openAtLogin)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit White Rabbit Helper", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        for entry in menu.items where entry.action != #selector(NSApplication.terminate(_:)) { entry.target = self }
        menu.delegate = self
        item.menu = menu

        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(syncNow), name: NSWorkspace.didWakeNotification, object: nil
        )
        render()
        syncNow()
    }

    @objc func syncNow() {
        Task { @MainActor in
            let (status, _) = await syncer.syncOnce()
            self.status = status
            if status == .watching { lastSync = Date() }
            render()
            scheduleNext()
        }
    }

    /** Every 5 minutes; every 30 seconds while waiting for access. */
    private func scheduleNext() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(
            timeInterval: status == .needsAccess ? 30 : 300,
            target: self, selector: #selector(syncNow), userInfo: nil, repeats: false
        )
    }

    private func render() {
        allowAccess.isHidden = status != .needsAccess
        switch status {
        case .watching:
            let when = lastSync.map { DateFormatter.localizedString(from: $0, dateStyle: .none, timeStyle: .short) }
            statusLine.title = when.map { "Watching Safari · synced \($0)" } ?? "Watching Safari"
        case .needsAccess: statusLine.title = "Needs Full Disk Access to read Safari"
        case .notPaired: statusLine.title = "Not connected. Add it again from White Rabbit."
        case .disconnected: statusLine.title = "Disconnected from White Rabbit"
        case .offline: statusLine.title = "Can't reach White Rabbit right now"
        case .noSafari: statusLine.title = "No Safari history on this Mac yet"
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        // It can also be switched off in System Settings → General → Login Items.
        openAtLogin.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    /** Only ever on when the person turns it on here. */
    @objc func toggleOpenAtLogin() {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled {
                try service.unregister()
            } else {
                try service.register()
                if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
            }
        } catch {
            log("open at login: \(error)")
            SMAppService.openSystemSettingsLoginItems()
        }
    }

    @objc func openWhiteRabbit() {
        let origin = loadConfig()?.origin
        if let url = URL(string: origin.map { allowedOrigin($0) ? $0 : productionOrigin } ?? productionOrigin) {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func openAccessSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
            NSWorkspace.shared.open(url)
        }
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
