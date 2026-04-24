package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/joho/godotenv"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	_ "modernc.org/sqlite"
)

const userPersonalDictionaryMaxEntries = 10

// --- Structures ---
type GuildIDReq struct {
	GuildID string `json:"guildId"`
}

type UserGuildIDReq struct {
	GuildID string `json:"guildId"`
	UserID  string `json:"userId"`
}

type UsageAddReq struct {
	GuildID    string  `json:"guildId"`
	TextLength float64 `json:"textLength"`
}

type ResetUsageReq struct {
	GuildID      string `json:"guildId"`
	CurrentMonth string `json:"currentMonth"`
}

type LicenseKeyReq struct {
	Key string `json:"key"`
}

type ActivateLicenseReq struct {
	Key     string `json:"key"`
	GuildID string `json:"guildId"`
}

type UpdateSpeakerReq struct {
	GuildID   string `json:"guildId"`
	UserID    string `json:"userId"`
	SpeakerID int    `json:"speakerId"`
	Type      string `json:"type"`
}

type UpdateValueReq struct {
	GuildID string  `json:"guildId"`
	UserID  string  `json:"userId"`
	Value   float64 `json:"value"`
}

type UpdateBoolReq struct {
	GuildID string `json:"guildId"`
	UserID  string `json:"userId"`
	Enable  bool   `json:"enable"`
}

type GuildUpdateBoolReq struct {
	GuildID string `json:"guildId"`
	Enable  bool   `json:"enable"`
}

type GuildUpdateSpeakerReq struct {
	GuildID   string `json:"guildId"`
	SpeakerID int    `json:"speakerId"`
	Type      string `json:"type"`
}

type DictAddReq struct {
	GuildID string `json:"guildId"`
	Word    string `json:"word"`
	ReadAs  string `json:"readAs"`
}

type DictRemoveReq struct {
	GuildID string `json:"guildId"`
	Word    string `json:"word"`
}

type DictRemoveIdReq struct {
	GuildID string `json:"guildId"`
	ID      int    `json:"id"`
}

type DictImportReq struct {
	GuildID string `json:"guildId"`
	Entries []struct {
		Word string `json:"word"`
		Read string `json:"read"`
	} `json:"entries"`
}

type UserPersonalDictAddReq struct {
	UserID string `json:"userId"`
	Word   string `json:"word"`
	ReadAs string `json:"readAs"`
}

type UserPersonalDictRemoveIdReq struct {
	UserID string `json:"userId"`
	ID     int    `json:"id"`
}

type UserPersonalDictListReq struct {
	UserID string `json:"userId"`
}

type ChannelPairReq struct {
	GuildID string `json:"guildId"`
	VoiceID string `json:"voiceId"`
	TextID  string `json:"textId"`
}

type ChannelReq struct {
	GuildID   string `json:"guildId"`
	ChannelID string `json:"channelId"`
}

type PresetAddReq struct {
	UserID   string `json:"userId"`
	Name     string `json:"name"`
	Settings struct {
		SpeakerID   int     `json:"speaker_id"`
		SpeakerType string  `json:"speaker_type"`
		Speed       float64 `json:"speed"`
		Pitch       float64 `json:"pitch"`
	} `json:"settings"`
}

type PresetUpdateReq struct {
	UserID   string `json:"userId"`
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Settings struct {
		SpeakerID   int     `json:"speaker_id"`
		SpeakerType string  `json:"speaker_type"`
		Speed       float64 `json:"speed"`
		Pitch       float64 `json:"pitch"`
	} `json:"settings"`
}

type PresetIDReq struct {
	ID     int    `json:"id"`
	UserID string `json:"userId"`
}

type AutoVCGenReq struct {
	GuildID       string `json:"guildId"`
	ChannelID     string `json:"channelId"`
	CategoryID    string `json:"categoryId"`
	TextChannelID string `json:"textChannelId"`
	NamingPattern string `json:"namingPattern"`
}

type AutoVCActiveReq struct {
	VoiceID          string `json:"voiceId"`
	ArchiveChannelID string `json:"archiveChannelId"`
	GuildID          string `json:"guildId"`
	OwnerID          string `json:"ownerId"`
}

type VoiceClaimReq struct {
	GuildID        string `json:"guildId"`
	VoiceChannelID string `json:"voiceChannelId"`
	OwnerID        string `json:"ownerId"`
	TTLSeconds     int64  `json:"ttlSeconds"`
}

type VoiceClaimReleaseReq struct {
	GuildID        string `json:"guildId"`
	VoiceChannelID string `json:"voiceChannelId"`
	OwnerID        string `json:"ownerId"`
}

type VoiceClaimOwnerReq struct {
	OwnerID string `json:"ownerId"`
}

type JoinRequestCreateReq struct {
	GuildID        string `json:"guildId"`
	VoiceChannelID string `json:"voiceChannelId"`
	TextChannelID  string `json:"textChannelId"`
	RequestedBy    string `json:"requestedBy"`
	TTLSeconds     int64  `json:"ttlSeconds"`
}

type JoinRequestDispatchReq struct {
	OwnerID          string   `json:"ownerId"`
	BusyGuildIDs     []string `json:"busyGuildIds"`
	EligibleGuildIDs []string `json:"eligibleGuildIds"`
	ClaimTTLSeconds  int64    `json:"claimTtlSeconds"`
}

type JoinRequestCompleteReq struct {
	ID      int64  `json:"id"`
	OwnerID string `json:"ownerId"`
	Success bool   `json:"success"`
	Message string `json:"message"`
}

type JoinRequestRequeueReq struct {
	ID         int64  `json:"id"`
	OwnerID    string `json:"ownerId"`
	TTLSeconds int64  `json:"ttlSeconds"`
}

// --- Databases ---
var (
	settingsDB *sql.DB
	usageDB    *sql.DB
	licenseDB  *sql.DB
	autovcDB   *sql.DB
	dbMutex    sync.Mutex

	// 同期用カウンター
	settingsWriteCount int
	licenseWriteCount  int
	autovcWriteCount   int
	syncTriggerMutex   sync.Mutex
)

// Configuration
var (
	ApiKey             = ""
	Port               = "5502"
	Version            = "1.0.0-Alpha-1o"
	DbDir              = "database"
	BackupDir          = "databasebackup"
	BackupGenerations  = 7
	PeerUrls           = []string{}
	SyncInterval       = 5 * time.Minute
	SyncWriteThreshold = 10
	NodeName           = ""
)

const (
	joinRequestsCreateTableSQL        = `CREATE TABLE IF NOT EXISTS join_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, voice_channel_id TEXT NOT NULL, text_channel_id TEXT, requested_by TEXT, status TEXT NOT NULL DEFAULT 'pending', assigned_owner_id TEXT, result_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`
	joinRequestsCreatePendingIndexSQL = `CREATE INDEX IF NOT EXISTS idx_join_requests_pending ON join_requests(status, created_at)`
	joinRequestsCreateExpiresIndexSQL = `CREATE INDEX IF NOT EXISTS idx_join_requests_expires ON join_requests(expires_at)`
	syncStateTableSQL                 = `CREATE TABLE IF NOT EXISTS layerd_sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, data_updated_at INTEGER NOT NULL, source_node TEXT NOT NULL)`
	syncStateUpsertSQL                = `INSERT INTO layerd_sync_state (id, revision, data_updated_at, source_node) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, data_updated_at = excluded.data_updated_at, source_node = excluded.source_node`
)

var joinRequestsRequiredColumns = []string{
	"id",
	"guild_id",
	"voice_channel_id",
	"text_channel_id",
	"requested_by",
	"status",
	"assigned_owner_id",
	"result_message",
	"created_at",
	"updated_at",
	"expires_at",
}

var guildSettingsRequiredColumns = []string{
	"default_speaker_id",
	"default_speaker_type",
}

type dbSyncState struct {
	Revision      int64
	DataUpdatedAt int64
	SourceNode    string
}

func closeLayerDDatabases() {
	if settingsDB != nil {
		_ = settingsDB.Close()
		settingsDB = nil
	}
	if usageDB != nil {
		_ = usageDB.Close()
		usageDB = nil
	}
	if licenseDB != nil {
		_ = licenseDB.Close()
		licenseDB = nil
	}
	if autovcDB != nil {
		_ = autovcDB.Close()
		autovcDB = nil
	}
}

func initialiseLayerDDatabases() error {
	if err := os.MkdirAll(DbDir, 0755); err != nil {
		return err
	}
	settingsDB = initDB(filepath.Join(DbDir, "settings.sqlite3"))
	usageDB = initDB(filepath.Join(DbDir, "usage.sqlite3"))
	licenseDB = initDB(filepath.Join(DbDir, "licenses.sqlite3"))
	autovcDB = initDB(filepath.Join(DbDir, "autovc.sqlite3"))
	setupTables()
	if err := ensureGuildSettingsSchema(settingsDB); err != nil {
		return err
	}
	if err := ensureJoinRequestsSchema(settingsDB); err != nil {
		return err
	}
	return nil
}

func newEchoWithLayerDRoutes() *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	e.Use(middleware.CORS())

	auth := func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			authHeader := c.Request().Header.Get("Authorization")
			if authHeader != "Bearer "+ApiKey {
				return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
			}
			return next(c)
		}
	}

	e.GET("/", func(c echo.Context) error {
		return c.String(http.StatusOK, fmt.Sprintf("💾 Layer-D (Database Worker) Go Version %s", Version))
	})

	e.POST("/usage/get", handleGetUsage, auth)
	e.POST("/usage/add", handleAddUsage, auth)
	e.POST("/usage/reset", handleResetUsage, auth)
	e.POST("/usage/all", handleGetAllUsage, auth)

	e.POST("/license/info", handleGetLicenseInfo, auth)
	e.POST("/license/add", handleAddLicenseKey, auth)
	e.POST("/license/activation", handleGetActivationInfo, auth)
	e.POST("/license/activate", handleActivateLicense, auth)
	e.POST("/license/deactivate", handleDeactivateLicense, auth)

	e.POST("/settings/user/get", handleGetUserSettings, auth)
	e.POST("/settings/user/update-speaker", handleUpdateUserSpeaker, auth)
	e.POST("/settings/user/update-speed", handleUpdateUserSpeed, auth)
	e.POST("/settings/user/update-pitch", handleUpdateUserPitch, auth)
	e.POST("/settings/user/reset", handleResetUserSettings, auth)
	e.POST("/settings/user/update-autojoin", handleUpdateUserAutoJoin, auth)
	e.POST("/settings/user/update-speech", handleUpdateUserActiveSpeech, auth)

	e.POST("/settings/guild/get", handleGetGuildSettings, auth)
	e.POST("/settings/guild/update-autojoin", handleUpdateGuildAutoJoin, auth)
	e.POST("/settings/guild/update-read-join", handleUpdateGuildReadJoin, auth)
	e.POST("/settings/guild/update-read-leave", handleUpdateGuildReadLeave, auth)
	e.POST("/settings/guild/update-speech", handleUpdateGuildActiveSpeech, auth)
	e.POST("/settings/guild/update-default-speaker", handleUpdateGuildDefaultSpeaker, auth)
	e.POST("/settings/guild/reset-default-speaker", handleResetGuildDefaultSpeaker, auth)

	e.POST("/dict/add", handleAddDict, auth)
	e.POST("/dict/remove", handleRemoveDict, auth)
	e.POST("/dict/remove-id", handleRemoveDictById, auth)
	e.POST("/dict/list", handleGetDictList, auth)
	e.POST("/dict/import", handleImportDict, auth)
	e.POST("/dict/clear", handleClearDict, auth)

	e.POST("/user-dict/add", handleAddUserPersonalDict, auth)
	e.POST("/user-dict/remove-id", handleRemoveUserPersonalDictById, auth)
	e.POST("/user-dict/list", handleGetUserPersonalDictList, auth)

	e.POST("/channels/pair/add", handleAddChannelPair, auth)
	e.POST("/channels/pair/remove", handleRemoveChannelPair, auth)
	e.POST("/channels/pair/get", handleGetChannelPair, auth)
	e.POST("/channels/pair/all", handleGetAllChannelPairs, auth)

	e.POST("/channels/ignore/add", handleAddIgnoreCh, auth)
	e.POST("/channels/ignore/remove", handleRemoveIgnoreCh, auth)
	e.POST("/channels/ignore/list", handleGetIgnoreChs, auth)
	e.POST("/channels/allow/add", handleAddAllowCh, auth)
	e.POST("/channels/allow/remove", handleRemoveAllowCh, auth)
	e.POST("/channels/allow/list", handleGetAllowChs, auth)

	e.POST("/presets/add", handleAddPreset, auth)
	e.POST("/presets/update", handleUpdatePreset, auth)
	e.POST("/presets/list", handleGetPresets, auth)
	e.POST("/presets/get", handleGetPreset, auth)
	e.POST("/presets/delete", handleDeletePreset, auth)

	e.POST("/autovc/gen/add", handleAddGenerator, auth)
	e.POST("/autovc/gen/get", handleGetGenerator, auth)
	e.POST("/autovc/gen/list", handleGetGenerators, auth)
	e.POST("/autovc/gen/remove", handleRemoveGenerator, auth)
	e.POST("/autovc/active/add", handleAddActiveChannel, auth)
	e.POST("/autovc/active/get", handleGetActiveChannel, auth)
	e.POST("/autovc/active/remove", handleRemoveActiveChannel, auth)
	e.POST("/autovc/active/get-owner", handleGetActiveChannelByOwner, auth)

	e.POST("/vc-claims/claim", handleClaimVoiceChannel, auth)
	e.POST("/vc-claims/heartbeat", handleHeartbeatVoiceChannelClaim, auth)
	e.POST("/vc-claims/release", handleReleaseVoiceChannelClaim, auth)
	e.POST("/vc-claims/release-owner", handleReleaseVoiceChannelClaimsByOwner, auth)
	e.POST("/vc-claims/get", handleGetVoiceChannelClaim, auth)

	e.POST("/join-requests/create", handleCreateJoinRequest, auth)
	e.POST("/join-requests/dispatch", handleDispatchJoinRequest, auth)
	e.POST("/join-requests/requeue", handleRequeueJoinRequest, auth)
	e.POST("/join-requests/complete", handleCompleteJoinRequest, auth)

	e.POST("/sync/push-now", handleSyncPushNow, auth)
	e.POST("/sync/receive", handleReceiveSync, auth)

	return e
}

func main() {
	_ = godotenv.Load()

	configPath := flag.String("config", "", "Path to config file (JSON)")
	portFlag := flag.String("port", "", "Port to listen on")
	dbDirFlag := flag.String("db-dir", "", "Directory for SQLite databases")
	backupDirFlag := flag.String("backup-dir", "", "Directory for backups")
	backupGenFlag := flag.Int("backup-generations", 0, "Number of backup generations to keep")
	peerUrlsFlag := flag.String("peer-urls", "", "Comma-separated list of peer URLs for sync")
	syncIntervalFlag := flag.Int("sync-interval", 0, "Sync interval in minutes (default 5)")
	syncThresholdFlag := flag.Int("sync-threshold", 0, "Immediate sync write threshold (default 10, usage excluded)")
	nodeNameFlag := flag.String("node-name", "", "Name of this node (default hostname)")
	flag.Parse()

	// 1. 設定ファイルからの読み込み (優先度低)
	cPath := *configPath
	if cPath == "" {
		// デフォルトパスのチェック
		defaultPath := "config/config.json"
		if _, err := os.Stat(defaultPath); err == nil {
			cPath = defaultPath
			log.Printf("Loading default config from %s", defaultPath)
		}
	}

	if cPath != "" {
		data, err := os.ReadFile(cPath)
		if err != nil {
			// 明示的な指定があった場合のみエラーログを出す
			if *configPath != "" {
				log.Printf("Warning: Could not read config file: %v", err)
			}
		} else {
			var cfg struct {
				Port              string   `json:"port"`
				ApiKey            string   `json:"api_key"`
				DbDir             string   `json:"db_dir"`
				BackupDir         string   `json:"backup_dir"`
				BackupGenerations int      `json:"backup_generations"`
				PeerUrls          []string `json:"peer_urls"`
				SyncInterval      int      `json:"sync_interval"`
				SyncThreshold     int      `json:"sync_threshold"`
				NodeName          string   `json:"node_name"`
			}
			if err := json.Unmarshal(data, &cfg); err != nil {
				log.Printf("Warning: Could not parse config file: %v", err)
			} else {
				if cfg.Port != "" {
					Port = cfg.Port
				}
				if cfg.ApiKey != "" {
					ApiKey = cfg.ApiKey
				}
				if cfg.DbDir != "" {
					DbDir = cfg.DbDir
				}
				if cfg.BackupDir != "" {
					BackupDir = cfg.BackupDir
				}
				if cfg.BackupGenerations > 0 {
					BackupGenerations = cfg.BackupGenerations
				}
				if len(cfg.PeerUrls) > 0 {
					PeerUrls = cfg.PeerUrls
				}
				if cfg.SyncInterval > 0 {
					SyncInterval = time.Duration(cfg.SyncInterval) * time.Minute
				}
				if cfg.SyncThreshold > 0 {
					SyncWriteThreshold = cfg.SyncThreshold
				}
				if cfg.NodeName != "" {
					NodeName = cfg.NodeName
				}
			}
		}
	}

	// 2. 環境変数での上書き
	if key := os.Getenv("DATABASE_API_KEY"); key != "" {
		ApiKey = key
	}
	if p := os.Getenv("PORT"); p != "" {
		Port = p
	}
	if envDir := os.Getenv("DATABASE_DIR"); envDir != "" {
		DbDir = envDir
	}
	if dir := os.Getenv("DATABASE_BACKUP_DIR"); dir != "" {
		BackupDir = dir
	}
	if gen := os.Getenv("DATABASE_BACKUP_GENERATIONS"); gen != "" {
		if val, err := strconv.Atoi(gen); err == nil {
			BackupGenerations = val
		}
	}
	if peers := os.Getenv("PEER_URLS"); peers != "" {
		PeerUrls = regexp.MustCompile(`,\s*`).Split(peers, -1)
	}
	if interval := os.Getenv("SYNC_INTERVAL"); interval != "" {
		if val, err := strconv.Atoi(interval); err == nil {
			SyncInterval = time.Duration(val) * time.Minute
		}
	}
	if name := os.Getenv("NODE_NAME"); name != "" {
		NodeName = name
	}

	// 3. コマンドライン引数での上書き (優先度高)
	if *portFlag != "" {
		Port = *portFlag
	}
	if *dbDirFlag != "" {
		DbDir = *dbDirFlag
	}
	if *backupDirFlag != "" {
		BackupDir = *backupDirFlag
	}
	if *backupGenFlag > 0 {
		BackupGenerations = *backupGenFlag
	}
	if *peerUrlsFlag != "" {
		PeerUrls = regexp.MustCompile(`,\s*`).Split(*peerUrlsFlag, -1)
	}
	if *syncIntervalFlag > 0 {
		SyncInterval = time.Duration(*syncIntervalFlag) * time.Minute
	}
	if *syncThresholdFlag > 0 {
		SyncWriteThreshold = *syncThresholdFlag
	}
	if *nodeNameFlag != "" {
		NodeName = *nodeNameFlag
	}

	if NodeName == "" {
		hostname, _ := os.Hostname()
		NodeName = hostname
	}

	if ApiKey == "" {
		log.Fatal("[Layer-D] DATABASE_API_KEY が設定されていません。環境変数または設定ファイルで DATABASE_API_KEY を設定してください。")
	}

	if err := initialiseLayerDDatabases(); err != nil {
		log.Fatalf("failed to initialise databases: %v", err)
	}
	if err := os.MkdirAll("peer_backups", 0755); err != nil {
		log.Fatal(err)
	}

	go runBackupLoop()
	go runSyncLoop()

	e := newEchoWithLayerDRoutes()
	log.Printf("💾 Layer-D (Database Worker) starting on port %s", Port)
	e.Logger.Fatal(e.Start(":" + Port))
}

func initDB(path string) *sql.DB {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		log.Fatalf("Failed to open DB %s: %v", path, err)
	}

	// Performance and Concurrency settings
	db.Exec("PRAGMA journal_mode=WAL")
	db.Exec("PRAGMA busy_timeout=5000")
	db.Exec("PRAGMA synchronous=NORMAL")

	if err := ensureSyncStateTable(db, path); err != nil {
		log.Fatalf("Failed to ensure sync state for %s: %v", path, err)
	}

	return db
}

func seedSyncState(dbPath string) dbSyncState {
	seedMs := time.Now().UnixMilli()
	if info, err := os.Stat(dbPath); err == nil {
		seedMs = info.ModTime().UnixMilli()
	}
	if seedMs < 0 {
		seedMs = 0
	}

	return dbSyncState{
		Revision:      1,
		DataUpdatedAt: seedMs,
		SourceNode:    NodeName,
	}
}

func ensureSyncStateTable(db *sql.DB, dbPath string) error {
	if db == nil {
		return fmt.Errorf("db is nil")
	}

	if _, err := db.Exec(syncStateTableSQL); err != nil {
		return err
	}

	var count int
	if err := db.QueryRow("SELECT COUNT(1) FROM layerd_sync_state WHERE id = 1").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	seed := seedSyncState(dbPath)
	_, err := db.Exec(syncStateUpsertSQL, seed.Revision, seed.DataUpdatedAt, seed.SourceNode)
	return err
}

func getDBSyncState(db *sql.DB) (dbSyncState, error) {
	state := dbSyncState{}
	if db == nil {
		return state, fmt.Errorf("db is nil")
	}

	if _, err := db.Exec(syncStateTableSQL); err != nil {
		return state, err
	}

	err := db.QueryRow("SELECT revision, data_updated_at, source_node FROM layerd_sync_state WHERE id = 1").Scan(
		&state.Revision,
		&state.DataUpdatedAt,
		&state.SourceNode,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return state, nil
		}
		return state, err
	}
	return state, nil
}

func getDBSyncStateFromFile(path string) (dbSyncState, error) {
	state := dbSyncState{}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return state, err
	}
	defer db.Close()

	err = db.QueryRow("SELECT revision, data_updated_at, source_node FROM layerd_sync_state WHERE id = 1").Scan(
		&state.Revision,
		&state.DataUpdatedAt,
		&state.SourceNode,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return state, nil
		}
		return state, err
	}
	return state, nil
}

func resolveDBTarget(dbName string) (**sql.DB, string, error) {
	localPath := filepath.Join(DbDir, dbName)
	switch dbName {
	case "settings.sqlite3":
		return &settingsDB, localPath, nil
	case "usage.sqlite3":
		return &usageDB, localPath, nil
	case "licenses.sqlite3":
		return &licenseDB, localPath, nil
	case "autovc.sqlite3":
		return &autovcDB, localPath, nil
	default:
		return nil, "", fmt.Errorf("unsupported db name: %s", dbName)
	}
}

func parseTimestampHeader(raw string) (int64, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0, fmt.Errorf("empty timestamp")
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, err
	}
	// 10桁前後は秒とみなし、ミリ秒に変換する
	if len(value) <= 10 {
		return parsed * 1000, nil
	}
	return parsed, nil
}

func shouldApplyRemoteSnapshot(localState, remoteState dbSyncState, localFileUpdatedMs, remoteFileUpdatedMs int64) bool {
	hasLocalRevision := localState.Revision > 0
	hasRemoteRevision := remoteState.Revision > 0
	hasLocalUpdated := localState.DataUpdatedAt > 0
	hasRemoteUpdated := remoteState.DataUpdatedAt > 0

	if hasLocalRevision && hasRemoteRevision && remoteState.Revision != localState.Revision {
		return remoteState.Revision > localState.Revision
	}
	if hasLocalUpdated && hasRemoteUpdated && remoteState.DataUpdatedAt != localState.DataUpdatedAt {
		return remoteState.DataUpdatedAt > localState.DataUpdatedAt
	}
	if !hasLocalUpdated && hasRemoteUpdated {
		return remoteState.DataUpdatedAt > localFileUpdatedMs
	}
	// 旧ノード混在時のフォールバック
	return remoteFileUpdatedMs > localFileUpdatedMs
}

func markDBUpdated(dbName string, db *sql.DB) {
	if db == nil {
		return
	}
	now := time.Now().UnixMilli()
	sourceNode := NodeName
	if strings.TrimSpace(sourceNode) == "" {
		sourceNode = "unknown"
	}

	if _, err := db.Exec(
		"UPDATE layerd_sync_state SET revision = revision + 1, data_updated_at = ?, source_node = ? WHERE id = 1",
		now, sourceNode,
	); err != nil {
		log.Printf("[Sync] Failed to update sync state for %s: %v", dbName, err)
	}
}

func setupTables() {
	usageDB.Exec(`CREATE TABLE IF NOT EXISTS guilds_usage (guild_id TEXT PRIMARY KEY, count REAL DEFAULT 0, last_reset_month TEXT)`)
	licenseDB.Exec(`CREATE TABLE IF NOT EXISTS licenses (key TEXT PRIMARY KEY, max_activations INTEGER DEFAULT 5, current_activations INTEGER DEFAULT 0, status TEXT DEFAULT 'active', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`)
	licenseDB.Exec(`CREATE TABLE IF NOT EXISTS activations (activation_id INTEGER PRIMARY KEY AUTOINCREMENT, license_key TEXT NOT NULL, guild_id TEXT NOT NULL UNIQUE, activation_date TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (license_key) REFERENCES licenses(key))`)
	settingsDB.Exec(`CREATE TABLE IF NOT EXISTS user_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, speaker_id INTEGER, speed REAL, pitch REAL, auto_join INTEGER DEFAULT 0, active_speech INTEGER DEFAULT 0, speaker_type TEXT DEFAULT 'voicevox', UNIQUE(guild_id, user_id))`)
	settingsDB.Exec(`CREATE TABLE IF NOT EXISTS guild_settings (guild_id TEXT PRIMARY KEY, auto_join_enabled INTEGER DEFAULT 0, read_join INTEGER DEFAULT 0, read_leave INTEGER DEFAULT 0, active_speech INTEGER DEFAULT 0, default_speaker_id INTEGER, default_speaker_type TEXT DEFAULT 'voicevox')`)
	settingsDB.Exec(`CREATE TABLE IF NOT EXISTS dictionaries (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, word TEXT NOT NULL, read_as TEXT NOT NULL, UNIQUE(guild_id, word))`)
	settingsDB.Exec(`CREATE TABLE IF NOT EXISTS user_personal_dictionaries (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, word TEXT NOT NULL, read_as TEXT NOT NULL, UNIQUE(user_id, word))`)
	settingsDB.Exec(`CREATE TABLE IF NOT EXISTS autojoin_ignore_channels (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, PRIMARY KEY(guild_id, channel_id))`)
	settingsDB.Exec(`CREATE TABLE IF NOT EXISTS autojoin_allow_channels (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, PRIMARY KEY(guild_id, channel_id))`)
	settingsDB.Exec(`CREATE TABLE IF NOT EXISTS autojoin_channel_pairs (guild_id TEXT NOT NULL, voice_channel_id TEXT NOT NULL, text_channel_id TEXT NOT NULL, PRIMARY KEY(guild_id, voice_channel_id))`)
	settingsDB.Exec(`CREATE TABLE IF NOT EXISTS voice_presets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, name TEXT NOT NULL, speaker_id INTEGER, speaker_type TEXT, speed REAL, pitch REAL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`)
	settingsDB.Exec(`CREATE TABLE IF NOT EXISTS voice_channel_claims (guild_id TEXT NOT NULL, voice_channel_id TEXT NOT NULL, owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(guild_id, voice_channel_id))`)
	settingsDB.Exec(`CREATE INDEX IF NOT EXISTS idx_voice_channel_claims_owner ON voice_channel_claims(owner_id)`)
	settingsDB.Exec(`CREATE INDEX IF NOT EXISTS idx_voice_channel_claims_expires ON voice_channel_claims(expires_at)`)
	settingsDB.Exec(joinRequestsCreateTableSQL)
	settingsDB.Exec(joinRequestsCreatePendingIndexSQL)
	settingsDB.Exec(joinRequestsCreateExpiresIndexSQL)
	autovcDB.Exec(`CREATE TABLE IF NOT EXISTS generators (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, category_id TEXT, text_channel_id TEXT, naming_pattern TEXT DEFAULT '{user}の部屋', PRIMARY KEY(guild_id, channel_id))`)
	autovcDB.Exec(`CREATE TABLE IF NOT EXISTS active_channels (voice_channel_id TEXT PRIMARY KEY, archive_channel_id TEXT, guild_id TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER)`)
}

type sqlColumnQueryer interface {
	Query(query string, args ...interface{}) (*sql.Rows, error)
}

func quoteIdentifier(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func listColumnNames(columns map[string]bool) []string {
	names := make([]string, 0, len(columns))
	for name := range columns {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func hasRequiredJoinRequestColumns(columns map[string]bool) bool {
	for _, required := range joinRequestsRequiredColumns {
		if !columns[required] {
			return false
		}
	}
	return true
}

func hasRequiredGuildSettingsColumns(columns map[string]bool) bool {
	for _, required := range guildSettingsRequiredColumns {
		if !columns[required] {
			return false
		}
	}
	return true
}

func getTableColumns(queryer sqlColumnQueryer, tableName string) (map[string]bool, error) {
	rows, err := queryer.Query(fmt.Sprintf("PRAGMA table_info(%s)", quoteIdentifier(tableName)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	columns := make(map[string]bool)
	for rows.Next() {
		var cid int
		var name string
		var columnType string
		var notNull int
		var defaultValue sql.NullString
		var primaryKey int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return nil, err
		}
		columns[name] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return columns, nil
}

func selectColumnOrDefault(columns map[string]bool, columnName, fallback string) string {
	if columns[columnName] {
		return columnName
	}
	return fallback
}

func normaliseSpeakerType(raw string) string {
	value := strings.TrimSpace(strings.ToLower(raw))
	if value == "ojt" {
		return "ojt"
	}
	return "voicevox"
}

func ensureGuildSettingsSchema(db *sql.DB) error {
	columns, err := getTableColumns(db, "guild_settings")
	if err != nil {
		return err
	}
	if hasRequiredGuildSettingsColumns(columns) {
		return nil
	}

	log.Printf("[Migration] guild_settings schema mismatch detected. current columns=%v", listColumnNames(columns))

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	columns, err = getTableColumns(tx, "guild_settings")
	if err != nil {
		return err
	}

	if !columns["default_speaker_id"] {
		if _, err := tx.Exec("ALTER TABLE guild_settings ADD COLUMN default_speaker_id INTEGER"); err != nil {
			return err
		}
	}

	if !columns["default_speaker_type"] {
		if _, err := tx.Exec("ALTER TABLE guild_settings ADD COLUMN default_speaker_type TEXT DEFAULT 'voicevox'"); err != nil {
			return err
		}
	}

	if _, err := tx.Exec("UPDATE guild_settings SET default_speaker_type = 'voicevox' WHERE default_speaker_type IS NULL OR trim(default_speaker_type) = ''"); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	log.Printf("[Migration] guild_settings schema migration completed successfully.")
	return nil
}

func ensureJoinRequestsSchema(db *sql.DB) error {
	columns, err := getTableColumns(db, "join_requests")
	if err != nil {
		return err
	}
	if hasRequiredJoinRequestColumns(columns) {
		return nil
	}

	log.Printf("[Migration] join_requests schema mismatch detected. current columns=%v", listColumnNames(columns))

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	columns, err = getTableColumns(tx, "join_requests")
	if err != nil {
		return err
	}
	if hasRequiredJoinRequestColumns(columns) {
		return tx.Commit()
	}

	if len(columns) == 0 {
		if _, err := tx.Exec(joinRequestsCreateTableSQL); err != nil {
			return err
		}
		if _, err := tx.Exec(joinRequestsCreatePendingIndexSQL); err != nil {
			return err
		}
		if _, err := tx.Exec(joinRequestsCreateExpiresIndexSQL); err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		log.Printf("[Migration] join_requests table was missing and has been created.")
		return nil
	}

	legacyTableName := fmt.Sprintf("join_requests_legacy_%d", time.Now().UnixMilli())
	quotedLegacyTableName := quoteIdentifier(legacyTableName)
	if _, err := tx.Exec("ALTER TABLE join_requests RENAME TO " + quotedLegacyTableName); err != nil {
		return err
	}

	if _, err := tx.Exec(joinRequestsCreateTableSQL); err != nil {
		return err
	}

	if columns["guild_id"] && columns["voice_channel_id"] {
		now := time.Now().UnixMilli()
		idExpr := selectColumnOrDefault(columns, "id", "NULL")
		guildIDExpr := selectColumnOrDefault(columns, "guild_id", "''")
		voiceChannelIDExpr := selectColumnOrDefault(columns, "voice_channel_id", "''")
		textChannelIDExpr := selectColumnOrDefault(columns, "text_channel_id", "NULL")
		requestedByExpr := selectColumnOrDefault(columns, "requested_by", "NULL")
		statusExpr := selectColumnOrDefault(columns, "status", "'pending'")
		assignedOwnerIDExpr := selectColumnOrDefault(columns, "assigned_owner_id", "NULL")
		resultMessageExpr := selectColumnOrDefault(columns, "result_message", "NULL")
		createdAtExpr := selectColumnOrDefault(columns, "created_at", selectColumnOrDefault(columns, "updated_at", strconv.FormatInt(now, 10)))
		updatedAtExpr := selectColumnOrDefault(columns, "updated_at", selectColumnOrDefault(columns, "created_at", strconv.FormatInt(now, 10)))
		expiresAtExpr := selectColumnOrDefault(columns, "expires_at", selectColumnOrDefault(columns, "updated_at", strconv.FormatInt(now+120000, 10)))

		insertSQL := fmt.Sprintf(
			"INSERT INTO join_requests (id, guild_id, voice_channel_id, text_channel_id, requested_by, status, assigned_owner_id, result_message, created_at, updated_at, expires_at) SELECT %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s FROM %s",
			idExpr, guildIDExpr, voiceChannelIDExpr, textChannelIDExpr, requestedByExpr, statusExpr, assignedOwnerIDExpr, resultMessageExpr, createdAtExpr, updatedAtExpr, expiresAtExpr, quotedLegacyTableName,
		)
		if _, err := tx.Exec(insertSQL); err != nil {
			return err
		}
	} else {
		log.Printf("[Migration] join_requests legacy table is missing key columns. skip data copy and recreate empty table.")
	}

	if _, err := tx.Exec("DROP TABLE " + quotedLegacyTableName); err != nil {
		return err
	}
	if _, err := tx.Exec(joinRequestsCreatePendingIndexSQL); err != nil {
		return err
	}
	if _, err := tx.Exec(joinRequestsCreateExpiresIndexSQL); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	log.Printf("[Migration] join_requests schema migration completed successfully.")
	return nil
}

// --- Handlers ---

func handleGetUsage(c echo.Context) error {
	req := new(GuildIDReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	var count float64
	var lastResetMonth sql.NullString
	err := usageDB.QueryRow("SELECT count, last_reset_month FROM guilds_usage WHERE guild_id = ?", req.GuildID).Scan(&count, &lastResetMonth)
	if err == sql.ErrNoRows {
		now := time.Now()
		month := fmt.Sprintf("%d-%02d", now.Year(), now.Month())
		usageDB.Exec("INSERT INTO guilds_usage (guild_id, count, last_reset_month) VALUES (?, 0, ?)", req.GuildID, month)
		markDBUpdated("usage.sqlite3", usageDB)
		return c.JSON(http.StatusOK, map[string]interface{}{"guild_id": req.GuildID, "count": 0, "last_reset_month": month})
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"guild_id": req.GuildID, "count": count, "last_reset_month": lastResetMonth.String})
}

func handleAddUsage(c echo.Context) error {
	req := new(UsageAddReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	_, err := usageDB.Exec("UPDATE guilds_usage SET count = count + ? WHERE guild_id = ?", req.TextLength, req.GuildID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
	markDBUpdated("usage.sqlite3", usageDB)
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleResetUsage(c echo.Context) error {
	req := new(ResetUsageReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	_, err := usageDB.Exec("UPDATE guilds_usage SET count = 0, last_reset_month = ? WHERE guild_id = ?", req.CurrentMonth, req.GuildID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
	markDBUpdated("usage.sqlite3", usageDB)
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleGetAllUsage(c echo.Context) error {
	rows, err := usageDB.Query("SELECT guild_id, count, last_reset_month FROM guilds_usage")
	if err != nil {
		return err
	}
	defer rows.Close()
	results := make([]map[string]interface{}, 0)
	for rows.Next() {
		var gid string
		var count float64
		var month string
		rows.Scan(&gid, &count, &month)
		results = append(results, map[string]interface{}{"guild_id": gid, "count": count, "last_reset_month": month})
	}
	return c.JSON(http.StatusOK, results)
}

func handleGetLicenseInfo(c echo.Context) error {
	req := new(LicenseKeyReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	var key, status, createdAt string
	var max, current int
	err := licenseDB.QueryRow("SELECT key, max_activations, current_activations, status, created_at FROM licenses WHERE key = ?", req.Key).Scan(&key, &max, &current, &status, &createdAt)
	if err == sql.ErrNoRows {
		return c.JSON(http.StatusOK, nil)
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"key": key, "max_activations": max, "current_activations": current, "status": status, "created_at": createdAt})
}

func handleAddLicenseKey(c echo.Context) error {
	var req struct {
		Key    string `json:"key"`
		Max    int    `json:"max"`
		Status string `json:"status"`
	}
	if err := c.Bind(&req); err != nil {
		return err
	}
	_, err := licenseDB.Exec("INSERT INTO licenses (key, max_activations, status) VALUES (?, ?, ?)", req.Key, req.Max, req.Status)
	if err == nil {
		incrementLicenseWrite()
	}
	if err != nil {
		return c.JSON(http.StatusConflict, map[string]string{"error": "Key exists"})
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleGetActivationInfo(c echo.Context) error {
	req := new(GuildIDReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	var licenseKey string
	err := licenseDB.QueryRow("SELECT license_key FROM activations WHERE guild_id = ?", req.GuildID).Scan(&licenseKey)
	if err == sql.ErrNoRows {
		return c.JSON(http.StatusOK, nil)
	}
	return c.JSON(http.StatusOK, map[string]string{"license_key": licenseKey, "guild_id": req.GuildID})
}

func handleActivateLicense(c echo.Context) error {
	req := new(ActivateLicenseReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	tx, err := licenseDB.Begin()
	if err != nil {
		return err
	}
	_, err = tx.Exec("INSERT INTO activations (license_key, guild_id) VALUES (?, ?)", req.Key, req.GuildID)
	if err != nil {
		tx.Rollback()
		return c.JSON(http.StatusConflict, map[string]string{"error": "Already active"})
	}
	_, err = tx.Exec("UPDATE licenses SET current_activations = current_activations + 1 WHERE key = ?", req.Key)
	if err == nil {
		incrementLicenseWrite()
	}
	if err != nil {
		tx.Rollback()
		return err
	}
	tx.Commit()
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleDeactivateLicense(c echo.Context) error {
	req := new(GuildIDReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	_, err := licenseDB.Exec("DELETE FROM activations WHERE guild_id = ?", req.GuildID)
	if err == nil {
		incrementLicenseWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleGetUserSettings(c echo.Context) error {
	req := new(UserGuildIDReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	var id, autoJoin, activeSpeech int
	var speakerId sql.NullInt64
	var speed, pitch sql.NullFloat64
	var speakerType sql.NullString
	var guildDefaultSpeakerID sql.NullInt64
	var guildDefaultSpeakerType sql.NullString

	readGuildDefault := func() {
		err := settingsDB.QueryRow("SELECT default_speaker_id, default_speaker_type FROM guild_settings WHERE guild_id = ?", req.GuildID).Scan(&guildDefaultSpeakerID, &guildDefaultSpeakerType)
		if err == sql.ErrNoRows {
			guildDefaultSpeakerID = sql.NullInt64{}
			guildDefaultSpeakerType = sql.NullString{}
			return
		}
		if err != nil {
			log.Printf("failed to read guild default speaker (guild_id=%s): %v", req.GuildID, err)
			guildDefaultSpeakerID = sql.NullInt64{}
			guildDefaultSpeakerType = sql.NullString{}
		}
	}

	err := settingsDB.QueryRow("SELECT id, speaker_id, speed, pitch, auto_join, active_speech, speaker_type FROM user_settings WHERE guild_id = ? AND user_id = ?", req.GuildID, req.UserID).Scan(&id, &speakerId, &speed, &pitch, &autoJoin, &activeSpeech, &speakerType)
	if err == sql.ErrNoRows {
		settingsDB.Exec("INSERT INTO user_settings (guild_id, user_id) VALUES (?, ?)", req.GuildID, req.UserID)
		readGuildDefault()
		response := map[string]interface{}{
			"guild_id":                   req.GuildID,
			"user_id":                    req.UserID,
			"speaker_id":                 nil,
			"speed":                      nil,
			"pitch":                      nil,
			"auto_join":                  0,
			"active_speech":              0,
			"speaker_type":               "voicevox",
			"guild_default_speaker_id":   nil,
			"guild_default_speaker_type": "voicevox",
		}
		if guildDefaultSpeakerID.Valid {
			response["guild_default_speaker_id"] = guildDefaultSpeakerID.Int64
		}
		if guildDefaultSpeakerType.Valid && strings.TrimSpace(guildDefaultSpeakerType.String) != "" {
			response["guild_default_speaker_type"] = normaliseSpeakerType(guildDefaultSpeakerType.String)
		}
		return c.JSON(http.StatusOK, response)
	}
	if err != nil {
		return err
	}
	res := map[string]interface{}{"guild_id": req.GuildID, "user_id": req.UserID, "auto_join": autoJoin, "active_speech": activeSpeech}
	if speakerId.Valid {
		res["speaker_id"] = speakerId.Int64
	} else {
		res["speaker_id"] = nil
	}
	if speed.Valid {
		res["speed"] = speed.Float64
	} else {
		res["speed"] = nil
	}
	if pitch.Valid {
		res["pitch"] = pitch.Float64
	} else {
		res["pitch"] = nil
	}
	if speakerType.Valid {
		res["speaker_type"] = normaliseSpeakerType(speakerType.String)
	} else {
		res["speaker_type"] = "voicevox"
	}

	readGuildDefault()
	if guildDefaultSpeakerID.Valid {
		res["guild_default_speaker_id"] = guildDefaultSpeakerID.Int64
	} else {
		res["guild_default_speaker_id"] = nil
	}
	if guildDefaultSpeakerType.Valid && strings.TrimSpace(guildDefaultSpeakerType.String) != "" {
		res["guild_default_speaker_type"] = normaliseSpeakerType(guildDefaultSpeakerType.String)
	} else {
		res["guild_default_speaker_type"] = "voicevox"
	}

	return c.JSON(http.StatusOK, res)
}

func handleUpdateUserSpeaker(c echo.Context) error {
	req := new(UpdateSpeakerReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	speakerType := normaliseSpeakerType(req.Type)
	settingsDB.Exec("INSERT OR IGNORE INTO user_settings (guild_id, user_id) VALUES (?, ?)", req.GuildID, req.UserID)
	_, err := settingsDB.Exec("UPDATE user_settings SET speaker_id = ?, speaker_type = ? WHERE guild_id = ? AND user_id = ?", req.SpeakerID, speakerType, req.GuildID, req.UserID)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleUpdateUserSpeed(c echo.Context) error {
	req := new(UpdateValueReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	settingsDB.Exec("INSERT OR IGNORE INTO user_settings (guild_id, user_id) VALUES (?, ?)", req.GuildID, req.UserID)
	_, err := settingsDB.Exec("UPDATE user_settings SET speed = ? WHERE guild_id = ? AND user_id = ?", req.Value, req.GuildID, req.UserID)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleUpdateUserPitch(c echo.Context) error {
	req := new(UpdateValueReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	settingsDB.Exec("INSERT OR IGNORE INTO user_settings (guild_id, user_id) VALUES (?, ?)", req.GuildID, req.UserID)
	_, err := settingsDB.Exec("UPDATE user_settings SET pitch = ? WHERE guild_id = ? AND user_id = ?", req.Value, req.GuildID, req.UserID)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleResetUserSettings(c echo.Context) error {
	req := new(UserGuildIDReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	_, err := settingsDB.Exec("UPDATE user_settings SET speaker_id = NULL, speed = NULL, pitch = NULL, speaker_type = 'voicevox' WHERE guild_id = ? AND user_id = ?", req.GuildID, req.UserID)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleUpdateUserAutoJoin(c echo.Context) error {
	req := new(UpdateBoolReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	val := 0
	if req.Enable {
		val = 1
	}
	settingsDB.Exec("INSERT OR IGNORE INTO user_settings (guild_id, user_id) VALUES (?, ?)", req.GuildID, req.UserID)
	_, err := settingsDB.Exec("UPDATE user_settings SET auto_join = ? WHERE guild_id = ? AND user_id = ?", val, req.GuildID, req.UserID)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleUpdateUserActiveSpeech(c echo.Context) error {
	req := new(UpdateBoolReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	val := 0
	if req.Enable {
		val = 1
	}
	settingsDB.Exec("INSERT OR IGNORE INTO user_settings (guild_id, user_id) VALUES (?, ?)", req.GuildID, req.UserID)
	_, err := settingsDB.Exec("UPDATE user_settings SET active_speech = ? WHERE guild_id = ? AND user_id = ?", val, req.GuildID, req.UserID)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleGetGuildSettings(c echo.Context) error {
	req := new(GuildIDReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	var gid string
	var autoJoin, readJoin, readLeave, activeSpeech int
	var defaultSpeakerID sql.NullInt64
	var defaultSpeakerType sql.NullString

	err := settingsDB.QueryRow("SELECT guild_id, auto_join_enabled, read_join, read_leave, active_speech, default_speaker_id, default_speaker_type FROM guild_settings WHERE guild_id = ?", req.GuildID).Scan(&gid, &autoJoin, &readJoin, &readLeave, &activeSpeech, &defaultSpeakerID, &defaultSpeakerType)
	if err == sql.ErrNoRows {
		return c.JSON(http.StatusOK, map[string]interface{}{
			"guild_id":             req.GuildID,
			"auto_join_enabled":    0,
			"read_join":            0,
			"read_leave":           0,
			"active_speech":        0,
			"default_speaker_id":   nil,
			"default_speaker_type": "voicevox",
		})
	}
	if err != nil {
		return err
	}

	response := map[string]interface{}{
		"guild_id":             gid,
		"auto_join_enabled":    autoJoin,
		"read_join":            readJoin,
		"read_leave":           readLeave,
		"active_speech":        activeSpeech,
		"default_speaker_id":   nil,
		"default_speaker_type": "voicevox",
	}
	if defaultSpeakerID.Valid {
		response["default_speaker_id"] = defaultSpeakerID.Int64
	}
	if defaultSpeakerType.Valid && strings.TrimSpace(defaultSpeakerType.String) != "" {
		response["default_speaker_type"] = normaliseSpeakerType(defaultSpeakerType.String)
	}

	return c.JSON(http.StatusOK, response)
}

func handleUpdateGuildAutoJoin(c echo.Context) error {
	req := new(GuildUpdateBoolReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	val := 0
	if req.Enable {
		val = 1
	}
	_, err := settingsDB.Exec("INSERT INTO guild_settings (guild_id, auto_join_enabled) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET auto_join_enabled = excluded.auto_join_enabled", req.GuildID, val)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleUpdateGuildReadJoin(c echo.Context) error {
	req := new(GuildUpdateBoolReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	val := 0
	if req.Enable {
		val = 1
	}
	_, err := settingsDB.Exec("INSERT INTO guild_settings (guild_id, read_join) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET read_join = excluded.read_join", req.GuildID, val)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleUpdateGuildReadLeave(c echo.Context) error {
	req := new(GuildUpdateBoolReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	val := 0
	if req.Enable {
		val = 1
	}
	_, err := settingsDB.Exec("INSERT INTO guild_settings (guild_id, read_leave) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET read_leave = excluded.read_leave", req.GuildID, val)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleUpdateGuildActiveSpeech(c echo.Context) error {
	req := new(GuildUpdateBoolReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	val := 0
	if req.Enable {
		val = 1
	}
	_, err := settingsDB.Exec("INSERT INTO guild_settings (guild_id, active_speech) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET active_speech = excluded.active_speech", req.GuildID, val)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleUpdateGuildDefaultSpeaker(c echo.Context) error {
	req := new(GuildUpdateSpeakerReq)
	if err := c.Bind(req); err != nil {
		return err
	}

	speakerType := normaliseSpeakerType(req.Type)

	_, err := settingsDB.Exec(
		"INSERT INTO guild_settings (guild_id, default_speaker_id, default_speaker_type) VALUES (?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET default_speaker_id = excluded.default_speaker_id, default_speaker_type = excluded.default_speaker_type",
		req.GuildID, req.SpeakerID, speakerType,
	)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleResetGuildDefaultSpeaker(c echo.Context) error {
	req := new(GuildIDReq)
	if err := c.Bind(req); err != nil {
		return err
	}

	_, err := settingsDB.Exec(
		"INSERT INTO guild_settings (guild_id, default_speaker_id, default_speaker_type) VALUES (?, NULL, 'voicevox') ON CONFLICT(guild_id) DO UPDATE SET default_speaker_id = NULL, default_speaker_type = 'voicevox'",
		req.GuildID,
	)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleAddDict(c echo.Context) error {
	req := new(DictAddReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	_, err := settingsDB.Exec("INSERT INTO dictionaries (guild_id, word, read_as) VALUES (?, ?, ?) ON CONFLICT(guild_id, word) DO UPDATE SET read_as = excluded.read_as", req.GuildID, req.Word, req.ReadAs)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleRemoveDict(c echo.Context) error {
	req := new(DictRemoveReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	res, err := settingsDB.Exec("DELETE FROM dictionaries WHERE guild_id = ? AND word = ?", req.GuildID, req.Word)
	if err == nil {
		incrementSettingsWrite()
	}
	count, _ := res.RowsAffected()
	return c.JSON(http.StatusOK, map[string]interface{}{"success": count > 0})
}

func handleRemoveDictById(c echo.Context) error {
	req := new(DictRemoveIdReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	res, err := settingsDB.Exec("DELETE FROM dictionaries WHERE id = ? AND guild_id = ?", req.ID, req.GuildID)
	if err == nil {
		incrementSettingsWrite()
	}
	count, _ := res.RowsAffected()
	return c.JSON(http.StatusOK, map[string]interface{}{"success": count > 0})
}

func handleGetDictList(c echo.Context) error {
	req := new(GuildIDReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	rows, err := settingsDB.Query("SELECT id, word, read_as FROM dictionaries WHERE guild_id = ? ORDER BY length(word) DESC", req.GuildID)
	if err != nil {
		return err
	}
	defer rows.Close()
	results := make([]map[string]interface{}, 0)
	for rows.Next() {
		var id int
		var word, read string
		rows.Scan(&id, &word, &read)
		results = append(results, map[string]interface{}{"id": id, "word": word, "read_as": read})
	}
	return c.JSON(http.StatusOK, results)
}

func handleImportDict(c echo.Context) error {
	req := new(DictImportReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	tx, _ := settingsDB.Begin()
	count := 0
	for _, entry := range req.Entries {
		if entry.Word != "" && entry.Read != "" {
			_, err := tx.Exec("INSERT INTO dictionaries (guild_id, word, read_as) VALUES (?, ?, ?) ON CONFLICT(guild_id, word) DO UPDATE SET read_as = excluded.read_as", req.GuildID, entry.Word, entry.Read)
			if err == nil {
				count++
			}
		}
	}
	if err := tx.Commit(); err == nil && count > 0 {
		incrementSettingsWrite()
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"count": count})
}

func handleClearDict(c echo.Context) error {
	req := new(GuildIDReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	res, err := settingsDB.Exec("DELETE FROM dictionaries WHERE guild_id = ?", req.GuildID)
	if err == nil {
		incrementSettingsWrite()
	}
	count, _ := res.RowsAffected()
	return c.JSON(http.StatusOK, map[string]interface{}{"count": count})
}

func handleAddUserPersonalDict(c echo.Context) error {
	req := new(UserPersonalDictAddReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	word := strings.TrimSpace(req.Word)
	readAs := strings.TrimSpace(req.ReadAs)
	if req.UserID == "" || word == "" || readAs == "" {
		return c.JSON(http.StatusOK, map[string]interface{}{"success": false, "error": "invalid"})
	}

	var existingCount int
	if err := settingsDB.QueryRow(
		"SELECT COUNT(*) FROM user_personal_dictionaries WHERE user_id = ? AND word = ?",
		req.UserID, word,
	).Scan(&existingCount); err != nil {
		return err
	}
	if existingCount == 0 {
		var total int
		if err := settingsDB.QueryRow(
			"SELECT COUNT(*) FROM user_personal_dictionaries WHERE user_id = ?",
			req.UserID,
		).Scan(&total); err != nil {
			return err
		}
		if total >= userPersonalDictionaryMaxEntries {
			return c.JSON(http.StatusOK, map[string]interface{}{
				"success": false,
				"error":   "limit",
				"max":     userPersonalDictionaryMaxEntries,
			})
		}
	}

	_, err := settingsDB.Exec(
		"INSERT INTO user_personal_dictionaries (user_id, word, read_as) VALUES (?, ?, ?) ON CONFLICT(user_id, word) DO UPDATE SET read_as = excluded.read_as",
		req.UserID, word, readAs,
	)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleRemoveUserPersonalDictById(c echo.Context) error {
	req := new(UserPersonalDictRemoveIdReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	if req.UserID == "" || req.ID <= 0 {
		return c.JSON(http.StatusOK, map[string]interface{}{"success": false})
	}
	res, err := settingsDB.Exec("DELETE FROM user_personal_dictionaries WHERE id = ? AND user_id = ?", req.ID, req.UserID)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	count, _ := res.RowsAffected()
	return c.JSON(http.StatusOK, map[string]interface{}{"success": count > 0})
}

func handleGetUserPersonalDictList(c echo.Context) error {
	req := new(UserPersonalDictListReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	if req.UserID == "" {
		return c.JSON(http.StatusOK, []interface{}{})
	}
	rows, err := settingsDB.Query(
		"SELECT id, word, read_as FROM user_personal_dictionaries WHERE user_id = ? ORDER BY length(word) DESC",
		req.UserID,
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	results := make([]map[string]interface{}, 0)
	for rows.Next() {
		var id int
		var word, read string
		if err := rows.Scan(&id, &word, &read); err != nil {
			return err
		}
		results = append(results, map[string]interface{}{"id": id, "word": word, "read_as": read})
	}
	return c.JSON(http.StatusOK, results)
}

func handleAddChannelPair(c echo.Context) error {
	req := new(ChannelPairReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	_, err := settingsDB.Exec("INSERT INTO autojoin_channel_pairs (guild_id, voice_channel_id, text_channel_id) VALUES (?, ?, ?) ON CONFLICT(guild_id, voice_channel_id) DO UPDATE SET text_channel_id = excluded.text_channel_id", req.GuildID, req.VoiceID, req.TextID)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleRemoveChannelPair(c echo.Context) error {
	var req struct {
		GuildID string `json:"guildId"`
		VoiceID string `json:"voiceId"`
	}
	if err := c.Bind(&req); err != nil {
		return err
	}
	res, err := settingsDB.Exec("DELETE FROM autojoin_channel_pairs WHERE guild_id = ? AND voice_channel_id = ?", req.GuildID, req.VoiceID)
	if err == nil {
		incrementSettingsWrite()
	}
	count, _ := res.RowsAffected()
	return c.JSON(http.StatusOK, map[string]interface{}{"success": count > 0})
}

func handleGetChannelPair(c echo.Context) error {
	var req struct {
		GuildID string `json:"guildId"`
		VoiceID string `json:"voiceId"`
	}
	if err := c.Bind(&req); err != nil {
		return err
	}
	var vid, tid string
	err := settingsDB.QueryRow("SELECT voice_channel_id, text_channel_id FROM autojoin_channel_pairs WHERE guild_id = ? AND voice_channel_id = ?", req.GuildID, req.VoiceID).Scan(&vid, &tid)
	if err == sql.ErrNoRows {
		return c.JSON(http.StatusOK, nil)
	}
	return c.JSON(http.StatusOK, map[string]string{"voice_channel_id": vid, "text_channel_id": tid})
}

func handleGetAllChannelPairs(c echo.Context) error {
	req := new(GuildIDReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	rows, _ := settingsDB.Query("SELECT voice_channel_id, text_channel_id FROM autojoin_channel_pairs WHERE guild_id = ?", req.GuildID)
	defer rows.Close()
	results := make([]map[string]string, 0)
	for rows.Next() {
		var vid, tid string
		rows.Scan(&vid, &tid)
		results = append(results, map[string]string{"voice_channel_id": vid, "text_channel_id": tid})
	}
	return c.JSON(http.StatusOK, results)
}

func handleAddIgnoreCh(c echo.Context) error {
	req := new(ChannelReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	_, err := settingsDB.Exec("INSERT OR IGNORE INTO autojoin_ignore_channels (guild_id, channel_id) VALUES (?, ?)", req.GuildID, req.ChannelID)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleRemoveIgnoreCh(c echo.Context) error {
	req := new(ChannelReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	res, err := settingsDB.Exec("DELETE FROM autojoin_ignore_channels WHERE guild_id = ? AND channel_id = ?", req.GuildID, req.ChannelID)
	if err == nil {
		incrementSettingsWrite()
	}
	count, _ := res.RowsAffected()
	return c.JSON(http.StatusOK, map[string]interface{}{"success": count > 0})
}

func handleGetIgnoreChs(c echo.Context) error {
	req := new(GuildIDReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	rows, _ := settingsDB.Query("SELECT channel_id FROM autojoin_ignore_channels WHERE guild_id = ?", req.GuildID)
	defer rows.Close()
	results := make([]string, 0)
	for rows.Next() {
		var cid string
		rows.Scan(&cid)
		results = append(results, cid)
	}
	return c.JSON(http.StatusOK, results)
}

func handleAddAllowCh(c echo.Context) error {
	req := new(ChannelReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	_, err := settingsDB.Exec("INSERT OR IGNORE INTO autojoin_allow_channels (guild_id, channel_id) VALUES (?, ?)", req.GuildID, req.ChannelID)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleRemoveAllowCh(c echo.Context) error {
	req := new(ChannelReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	res, err := settingsDB.Exec("DELETE FROM autojoin_allow_channels WHERE guild_id = ? AND channel_id = ?", req.GuildID, req.ChannelID)
	if err == nil {
		incrementSettingsWrite()
	}
	count, _ := res.RowsAffected()
	return c.JSON(http.StatusOK, map[string]interface{}{"success": count > 0})
}

func handleGetAllowChs(c echo.Context) error {
	req := new(GuildIDReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	rows, _ := settingsDB.Query("SELECT channel_id FROM autojoin_allow_channels WHERE guild_id = ?", req.GuildID)
	defer rows.Close()
	results := make([]string, 0)
	for rows.Next() {
		var cid string
		rows.Scan(&cid)
		results = append(results, cid)
	}
	return c.JSON(http.StatusOK, results)
}

func handleAddPreset(c echo.Context) error {
	req := new(PresetAddReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	_, err := settingsDB.Exec("INSERT INTO voice_presets (user_id, name, speaker_id, speaker_type, speed, pitch) VALUES (?, ?, ?, ?, ?, ?)", req.UserID, req.Name, req.Settings.SpeakerID, req.Settings.SpeakerType, req.Settings.Speed, req.Settings.Pitch)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleUpdatePreset(c echo.Context) error {
	req := new(PresetUpdateReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	_, err := settingsDB.Exec("UPDATE voice_presets SET name = ?, speaker_id = ?, speaker_type = ?, speed = ?, pitch = ? WHERE id = ? AND user_id = ?", req.Name, req.Settings.SpeakerID, req.Settings.SpeakerType, req.Settings.Speed, req.Settings.Pitch, req.ID, req.UserID)
	if err == nil {
		incrementSettingsWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleGetPresets(c echo.Context) error {
	var req struct {
		UserID string `json:"userId"`
	}
	if err := c.Bind(&req); err != nil {
		return err
	}
	rows, _ := settingsDB.Query("SELECT id, user_id, name, speaker_id, speaker_type, speed, pitch, created_at FROM voice_presets WHERE user_id = ? ORDER BY created_at DESC", req.UserID)
	defer rows.Close()
	results := make([]map[string]interface{}, 0)
	for rows.Next() {
		var id, sid int
		var uid, name, stype, cat string
		var speed, pitch float64
		rows.Scan(&id, &uid, &name, &sid, &stype, &speed, &pitch, &cat)
		results = append(results, map[string]interface{}{"id": id, "user_id": uid, "name": name, "speaker_id": sid, "speaker_type": stype, "speed": speed, "pitch": pitch, "created_at": cat})
	}
	return c.JSON(http.StatusOK, results)
}

func handleGetPreset(c echo.Context) error {
	var req struct {
		ID int `json:"id"`
	}
	if err := c.Bind(&req); err != nil {
		return err
	}
	var id, sid int
	var uid, name, stype, cat string
	var speed, pitch float64
	err := settingsDB.QueryRow("SELECT id, user_id, name, speaker_id, speaker_type, speed, pitch, created_at FROM voice_presets WHERE id = ?", req.ID).Scan(&id, &uid, &name, &sid, &stype, &speed, &pitch, &cat)
	if err == sql.ErrNoRows {
		return c.JSON(http.StatusOK, nil)
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"id": id, "user_id": uid, "name": name, "speaker_id": sid, "speaker_type": stype, "speed": speed, "pitch": pitch, "created_at": cat})
}

func handleDeletePreset(c echo.Context) error {
	req := new(PresetIDReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	_, err := settingsDB.Exec("DELETE FROM voice_presets WHERE id = ? AND user_id = ?", req.ID, req.UserID)
	if err == nil {
		incrementSettingsWrite()
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleAddGenerator(c echo.Context) error {
	req := new(AutoVCGenReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	_, err := autovcDB.Exec("INSERT OR REPLACE INTO generators (guild_id, channel_id, category_id, text_channel_id, naming_pattern) VALUES (?, ?, ?, ?, ?)", req.GuildID, req.ChannelID, req.CategoryID, req.TextChannelID, req.NamingPattern)
	if err == nil {
		incrementAutovcWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleGetGenerator(c echo.Context) error {
	req := new(ChannelReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	var gid, cid, cat, tid, pattern string
	err := autovcDB.QueryRow("SELECT guild_id, channel_id, category_id, text_channel_id, naming_pattern FROM generators WHERE guild_id = ? AND channel_id = ?", req.GuildID, req.ChannelID).Scan(&gid, &cid, &cat, &tid, &pattern)
	if err == sql.ErrNoRows {
		return c.JSON(http.StatusOK, nil)
	}
	return c.JSON(http.StatusOK, map[string]string{"guild_id": gid, "channel_id": cid, "category_id": cat, "text_channel_id": tid, "naming_pattern": pattern})
}

func handleGetGenerators(c echo.Context) error {
	req := new(GuildIDReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	rows, _ := autovcDB.Query("SELECT guild_id, channel_id, category_id, text_channel_id, naming_pattern FROM generators WHERE guild_id = ?", req.GuildID)
	defer rows.Close()
	results := make([]map[string]string, 0)
	for rows.Next() {
		var gid, cid, cat, tid, pattern string
		rows.Scan(&gid, &cid, &cat, &tid, &pattern)
		results = append(results, map[string]string{"guild_id": gid, "channel_id": cid, "category_id": cat, "text_channel_id": tid, "naming_pattern": pattern})
	}
	return c.JSON(http.StatusOK, results)
}

func handleRemoveGenerator(c echo.Context) error {
	req := new(ChannelReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	_, err := autovcDB.Exec("DELETE FROM generators WHERE guild_id = ? AND channel_id = ?", req.GuildID, req.ChannelID)
	if err == nil {
		incrementAutovcWrite()
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleAddActiveChannel(c echo.Context) error {
	req := new(AutoVCActiveReq)
	if err := c.Bind(req); err != nil {
		return err
	}
	_, err := autovcDB.Exec("INSERT INTO active_channels (voice_channel_id, archive_channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, ?, ?)", req.VoiceID, req.ArchiveChannelID, req.GuildID, req.OwnerID, time.Now().UnixMilli())
	if err == nil {
		incrementAutovcWrite()
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleGetActiveChannel(c echo.Context) error {
	var req struct {
		VoiceID string `json:"voiceId"`
	}
	if err := c.Bind(&req); err != nil {
		return err
	}
	var vid, aid, gid, oid string
	var cat int64
	err := autovcDB.QueryRow("SELECT voice_channel_id, archive_channel_id, guild_id, owner_id, created_at FROM active_channels WHERE voice_channel_id = ?", req.VoiceID).Scan(&vid, &aid, &gid, &oid, &cat)
	if err == sql.ErrNoRows {
		return c.JSON(http.StatusOK, nil)
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"voice_channel_id": vid, "archive_channel_id": aid, "guild_id": gid, "owner_id": oid, "created_at": cat})
}

func handleRemoveActiveChannel(c echo.Context) error {
	var req struct {
		VoiceID string `json:"voiceId"`
	}
	if err := c.Bind(&req); err != nil {
		return err
	}
	_, err := autovcDB.Exec("DELETE FROM active_channels WHERE voice_channel_id = ?", req.VoiceID)
	if err == nil {
		incrementAutovcWrite()
	}
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleGetActiveChannelByOwner(c echo.Context) error {
	var req struct {
		OwnerID string `json:"ownerId"`
	}
	if err := c.Bind(&req); err != nil {
		return err
	}
	var vid, aid, gid, oid string
	var cat int64
	err := autovcDB.QueryRow("SELECT voice_channel_id, archive_channel_id, guild_id, owner_id, created_at FROM active_channels WHERE owner_id = ?", req.OwnerID).Scan(&vid, &aid, &gid, &oid, &cat)
	if err == sql.ErrNoRows {
		return c.JSON(http.StatusOK, nil)
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"voice_channel_id": vid, "archive_channel_id": aid, "guild_id": gid, "owner_id": oid, "created_at": cat})
}

func handleClaimVoiceChannel(c echo.Context) error {
	req := new(VoiceClaimReq)
	if err := c.Bind(req); err != nil {
		return err
	}

	if req.GuildID == "" || req.VoiceChannelID == "" || req.OwnerID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "guildId, voiceChannelId, ownerId are required"})
	}

	ttlSeconds := req.TTLSeconds
	if ttlSeconds <= 0 {
		ttlSeconds = 90
	}

	now := time.Now().UnixMilli()
	expiresAt := now + (ttlSeconds * 1000)

	// 原子的な条件付きUPSERTでレースを防ぐ:
	// 既存オーナーと同一、または期限切れのときのみ上書きを許可する。
	res, err := settingsDB.Exec(
		`INSERT INTO voice_channel_claims (guild_id, voice_channel_id, owner_id, expires_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(guild_id, voice_channel_id) DO UPDATE SET
		     owner_id = excluded.owner_id,
		     expires_at = excluded.expires_at,
		     updated_at = excluded.updated_at
		 WHERE voice_channel_claims.owner_id = excluded.owner_id
		    OR voice_channel_claims.expires_at <= ?`,
		req.GuildID, req.VoiceChannelID, req.OwnerID, expiresAt, now, now,
	)
	if err != nil {
		return err
	}

	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}

	if affected > 0 {
		incrementSettingsWrite()
		return c.JSON(http.StatusOK, map[string]interface{}{
			"success":          true,
			"claimed":          true,
			"owner_id":         req.OwnerID,
			"expires_at":       expiresAt,
			"ttl_seconds":      ttlSeconds,
			"guild_id":         req.GuildID,
			"voice_channel_id": req.VoiceChannelID,
		})
	}

	var ownerID string
	var currentExpiresAt int64
	err = settingsDB.QueryRow(
		"SELECT owner_id, expires_at FROM voice_channel_claims WHERE guild_id = ? AND voice_channel_id = ?",
		req.GuildID, req.VoiceChannelID,
	).Scan(&ownerID, &currentExpiresAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusOK, map[string]interface{}{
				"success":          true,
				"claimed":          false,
				"owner_id":         "",
				"expires_at":       int64(0),
				"guild_id":         req.GuildID,
				"voice_channel_id": req.VoiceChannelID,
			})
		}
		return err
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success":          true,
		"claimed":          false,
		"owner_id":         ownerID,
		"expires_at":       currentExpiresAt,
		"guild_id":         req.GuildID,
		"voice_channel_id": req.VoiceChannelID,
	})
}

func handleHeartbeatVoiceChannelClaim(c echo.Context) error {
	req := new(VoiceClaimReq)
	if err := c.Bind(req); err != nil {
		return err
	}

	if req.GuildID == "" || req.VoiceChannelID == "" || req.OwnerID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "guildId, voiceChannelId, ownerId are required"})
	}

	ttlSeconds := req.TTLSeconds
	if ttlSeconds <= 0 {
		ttlSeconds = 90
	}

	now := time.Now().UnixMilli()
	expiresAt := now + (ttlSeconds * 1000)

	res, err := settingsDB.Exec(
		"UPDATE voice_channel_claims SET expires_at = ?, updated_at = ? WHERE guild_id = ? AND voice_channel_id = ? AND owner_id = ?",
		expiresAt, now, req.GuildID, req.VoiceChannelID, req.OwnerID,
	)
	if err != nil {
		return err
	}

	affected, _ := res.RowsAffected()
	renewed := affected > 0
	if renewed {
		incrementSettingsWrite()
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success":          true,
		"renewed":          renewed,
		"owner_id":         req.OwnerID,
		"expires_at":       expiresAt,
		"guild_id":         req.GuildID,
		"voice_channel_id": req.VoiceChannelID,
	})
}

func handleReleaseVoiceChannelClaim(c echo.Context) error {
	req := new(VoiceClaimReleaseReq)
	if err := c.Bind(req); err != nil {
		return err
	}

	if req.GuildID == "" || req.VoiceChannelID == "" || req.OwnerID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "guildId, voiceChannelId, ownerId are required"})
	}

	now := time.Now().UnixMilli()
	res, err := settingsDB.Exec(
		"DELETE FROM voice_channel_claims WHERE guild_id = ? AND voice_channel_id = ? AND (owner_id = ? OR expires_at <= ?)",
		req.GuildID, req.VoiceChannelID, req.OwnerID, now,
	)
	if err != nil {
		return err
	}

	affected, _ := res.RowsAffected()
	released := affected > 0
	if released {
		incrementSettingsWrite()
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success":          true,
		"released":         released,
		"guild_id":         req.GuildID,
		"voice_channel_id": req.VoiceChannelID,
	})
}

func handleReleaseVoiceChannelClaimsByOwner(c echo.Context) error {
	req := new(VoiceClaimOwnerReq)
	if err := c.Bind(req); err != nil {
		return err
	}

	if req.OwnerID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "ownerId is required"})
	}

	res, err := settingsDB.Exec("DELETE FROM voice_channel_claims WHERE owner_id = ?", req.OwnerID)
	if err != nil {
		return err
	}

	affected, _ := res.RowsAffected()
	if affected > 0 {
		incrementSettingsWrite()
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success":  true,
		"released": affected,
		"owner_id": req.OwnerID,
	})
}

func handleGetVoiceChannelClaim(c echo.Context) error {
	var req struct {
		GuildID        string `json:"guildId"`
		VoiceChannelID string `json:"voiceChannelId"`
	}
	if err := c.Bind(&req); err != nil {
		return err
	}

	if req.GuildID == "" || req.VoiceChannelID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "guildId and voiceChannelId are required"})
	}

	now := time.Now().UnixMilli()
	var ownerID string
	var expiresAt int64
	err := settingsDB.QueryRow(
		"SELECT owner_id, expires_at FROM voice_channel_claims WHERE guild_id = ? AND voice_channel_id = ?",
		req.GuildID, req.VoiceChannelID,
	).Scan(&ownerID, &expiresAt)
	if err == sql.ErrNoRows {
		return c.JSON(http.StatusOK, nil)
	}
	if err != nil {
		return err
	}

	if expiresAt <= now {
		if _, delErr := settingsDB.Exec("DELETE FROM voice_channel_claims WHERE guild_id = ? AND voice_channel_id = ?", req.GuildID, req.VoiceChannelID); delErr == nil {
			incrementSettingsWrite()
		}
		return c.JSON(http.StatusOK, nil)
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"guild_id":         req.GuildID,
		"voice_channel_id": req.VoiceChannelID,
		"owner_id":         ownerID,
		"expires_at":       expiresAt,
	})
}

func cleanupExpiredJoinRequests(now int64) {
	_, _ = settingsDB.Exec("DELETE FROM join_requests WHERE expires_at <= ? AND status IN ('pending', 'claimed')", now)
}

func handleCreateJoinRequest(c echo.Context) error {
	req := new(JoinRequestCreateReq)
	if err := c.Bind(req); err != nil {
		return err
	}

	if req.GuildID == "" || req.VoiceChannelID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "guildId and voiceChannelId are required"})
	}

	ttlSeconds := req.TTLSeconds
	if ttlSeconds <= 0 {
		ttlSeconds = 120
	}

	now := time.Now().UnixMilli()
	expiresAt := now + (ttlSeconds * 1000)

	res, err := settingsDB.Exec(
		"INSERT INTO join_requests (guild_id, voice_channel_id, text_channel_id, requested_by, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
		req.GuildID, req.VoiceChannelID, req.TextChannelID, req.RequestedBy, now, now, expiresAt,
	)
	if err != nil {
		return err
	}

	id, _ := res.LastInsertId()
	incrementSettingsWrite()
	return c.JSON(http.StatusOK, map[string]interface{}{
		"success":          true,
		"id":               id,
		"guild_id":         req.GuildID,
		"voice_channel_id": req.VoiceChannelID,
		"text_channel_id":  req.TextChannelID,
		"status":           "pending",
		"expires_at":       expiresAt,
	})
}

func handleDispatchJoinRequest(c echo.Context) error {
	req := new(JoinRequestDispatchReq)
	if err := c.Bind(req); err != nil {
		return err
	}

	if req.OwnerID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "ownerId is required"})
	}
	if len(req.EligibleGuildIDs) == 0 {
		return c.JSON(http.StatusOK, nil)
	}

	claimTTLSeconds := req.ClaimTTLSeconds
	if claimTTLSeconds <= 0 {
		claimTTLSeconds = 45
	}

	now := time.Now().UnixMilli()
	cleanupExpiredJoinRequests(now)

	tx, err := settingsDB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	baseQuery := "SELECT id, guild_id, voice_channel_id, text_channel_id, requested_by, created_at FROM join_requests WHERE status = 'pending' AND expires_at > ?"
	args := []interface{}{now}
	eligibleHolders := make([]string, 0, len(req.EligibleGuildIDs))
	for _, guildID := range req.EligibleGuildIDs {
		if guildID == "" {
			continue
		}
		eligibleHolders = append(eligibleHolders, "?")
		args = append(args, guildID)
	}
	if len(eligibleHolders) == 0 {
		return c.JSON(http.StatusOK, nil)
	}
	baseQuery += " AND guild_id IN (" + strings.Join(eligibleHolders, ",") + ")"

	if len(req.BusyGuildIDs) > 0 {
		holders := make([]string, 0, len(req.BusyGuildIDs))
		for _, guildID := range req.BusyGuildIDs {
			if guildID == "" {
				continue
			}
			holders = append(holders, "?")
			args = append(args, guildID)
		}
		if len(holders) > 0 {
			baseQuery += " AND guild_id NOT IN (" + strings.Join(holders, ",") + ")"
		}
	}
	baseQuery += " ORDER BY created_at ASC LIMIT 1"

	var requestID int64
	var guildID string
	var voiceChannelID string
	var textChannelID sql.NullString
	var requestedBy sql.NullString
	var createdAt int64
	err = tx.QueryRow(baseQuery, args...).Scan(&requestID, &guildID, &voiceChannelID, &textChannelID, &requestedBy, &createdAt)
	if err == sql.ErrNoRows {
		return c.JSON(http.StatusOK, nil)
	}
	if err != nil {
		return err
	}

	expiresAt := now + (claimTTLSeconds * 1000)
	res, err := tx.Exec(
		"UPDATE join_requests SET status = 'claimed', assigned_owner_id = ?, updated_at = ?, expires_at = ? WHERE id = ? AND status = 'pending'",
		req.OwnerID, now, expiresAt, requestID,
	)
	if err != nil {
		return err
	}

	affected, _ := res.RowsAffected()
	if affected == 0 {
		return c.JSON(http.StatusOK, nil)
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	incrementSettingsWrite()
	return c.JSON(http.StatusOK, map[string]interface{}{
		"id":                requestID,
		"guild_id":          guildID,
		"voice_channel_id":  voiceChannelID,
		"text_channel_id":   textChannelID.String,
		"requested_by":      requestedBy.String,
		"status":            "claimed",
		"assigned_owner_id": req.OwnerID,
		"created_at":        createdAt,
		"expires_at":        expiresAt,
	})
}

func handleCompleteJoinRequest(c echo.Context) error {
	req := new(JoinRequestCompleteReq)
	if err := c.Bind(req); err != nil {
		return err
	}

	if req.ID <= 0 || req.OwnerID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "id and ownerId are required"})
	}

	now := time.Now().UnixMilli()
	status := "done"
	if !req.Success {
		status = "failed"
	}

	res, err := settingsDB.Exec(
		"UPDATE join_requests SET status = ?, result_message = ?, updated_at = ?, expires_at = ? WHERE id = ? AND assigned_owner_id = ? AND status = 'claimed'",
		status, req.Message, now, now+300000, req.ID, req.OwnerID,
	)
	if err != nil {
		return err
	}

	affected, _ := res.RowsAffected()
	completed := affected > 0
	if completed {
		incrementSettingsWrite()
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success":   true,
		"completed": completed,
		"status":    status,
		"id":        req.ID,
	})
}

func handleRequeueJoinRequest(c echo.Context) error {
	req := new(JoinRequestRequeueReq)
	if err := c.Bind(req); err != nil {
		return err
	}

	if req.ID <= 0 || req.OwnerID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "id and ownerId are required"})
	}

	ttlSeconds := req.TTLSeconds
	if ttlSeconds <= 0 {
		ttlSeconds = 120
	}

	now := time.Now().UnixMilli()
	expiresAt := now + (ttlSeconds * 1000)

	res, err := settingsDB.Exec(
		"UPDATE join_requests SET status = 'pending', assigned_owner_id = NULL, result_message = NULL, updated_at = ?, expires_at = ? WHERE id = ? AND assigned_owner_id = ? AND status = 'claimed'",
		now, expiresAt, req.ID, req.OwnerID,
	)
	if err != nil {
		return err
	}

	affected, _ := res.RowsAffected()
	requeued := affected > 0
	if requeued {
		incrementSettingsWrite()
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success":    true,
		"requeued":   requeued,
		"id":         req.ID,
		"expires_at": expiresAt,
	})
}

// --- Backup Functions ---

func runBackupLoop() {
	for {
		log.Printf("[Backup] Starting automatic backup (Generations: %d)...", BackupGenerations)
		backupDatabases()
		cleanupOldBackups()

		// 24時間待機
		time.Sleep(24 * time.Hour)
	}
}

func backupDatabases() {
	now := time.Now()
	dateStr := now.Format("20060102")
	destDir := filepath.Join(BackupDir, dateStr)

	if err := os.MkdirAll(destDir, 0755); err != nil {
		log.Printf("[Backup] Error creating backup directory %s: %v", destDir, err)
		return
	}

	dbs := []struct {
		name string
		db   *sql.DB
	}{
		{"settings.sqlite3", settingsDB},
		{"usage.sqlite3", usageDB},
		{"licenses.sqlite3", licenseDB},
		{"autovc.sqlite3", autovcDB},
	}

	for _, item := range dbs {
		if item.db == nil {
			continue
		}
		destPath := filepath.Join(destDir, item.name)

		// VACUUM INTO は出力先ファイルが存在するとエラーになるため削除しておく
		os.Remove(destPath)

		// 稼働中のデータベースを一貫性を保って安全にコピー
		_, err := item.db.Exec(fmt.Sprintf("VACUUM INTO '%s'", destPath))
		if err != nil {
			log.Printf("[Backup] Error backing up %s: %v", item.name, err)
		} else {
			log.Printf("[Backup] Successfully backed up %s to %s", item.name, destPath)
		}
	}
}

func cleanupOldBackups() {
	entries, err := os.ReadDir(BackupDir)
	if err != nil {
		log.Printf("[Backup] Error reading backup directory: %v", err)
		return
	}

	var backups []string
	re := regexp.MustCompile(`^[0-9]{8}$`)

	for _, entry := range entries {
		if entry.IsDir() && re.MatchString(entry.Name()) {
			backups = append(backups, entry.Name())
		}
	}

	// os.ReadDir は名前順でソートされているため古いものから並ぶ
	sort.Strings(backups)

	if len(backups) > BackupGenerations {
		toDelete := len(backups) - BackupGenerations
		for i := 0; i < toDelete; i++ {
			dirPath := filepath.Join(BackupDir, backups[i])
			if err := os.RemoveAll(dirPath); err != nil {
				log.Printf("[Backup] Error deleting old backup %s: %v", dirPath, err)
			} else {
				log.Printf("[Backup] Deleted old backup: %s", dirPath)
			}
		}
	}
}

// --- Sync Handlers & Functions ---

func handleReceiveSync(c echo.Context) error {
	sourceNode := c.Request().Header.Get("X-Source-Node")
	dbName := c.QueryParam("db")
	lastUpdatedStr := c.Request().Header.Get("X-Last-Updated")
	revisionStr := c.Request().Header.Get("X-Data-Revision")
	dataUpdatedStr := c.Request().Header.Get("X-Data-Updated-At")

	if sourceNode == "" || dbName == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Missing required headers or params"})
	}

	targetDB, localPath, err := resolveDBTarget(dbName)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": err.Error()})
	}

	localFileUpdatedMs := int64(0)
	if localInfo, statErr := os.Stat(localPath); statErr == nil {
		localFileUpdatedMs = localInfo.ModTime().UnixMilli()
	}

	localState := dbSyncState{}
	if targetDB != nil && *targetDB != nil {
		state, stateErr := getDBSyncState(*targetDB)
		if stateErr != nil {
			log.Printf("[Sync] Failed to read local sync state (%s): %v", dbName, stateErr)
		} else {
			localState = state
		}
	}

	remoteState := dbSyncState{SourceNode: sourceNode}
	if revisionStr != "" {
		parsedRevision, parseErr := strconv.ParseInt(strings.TrimSpace(revisionStr), 10, 64)
		if parseErr != nil {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid X-Data-Revision"})
		}
		remoteState.Revision = parsedRevision
	}
	if dataUpdatedStr != "" {
		parsedDataUpdatedAt, parseErr := parseTimestampHeader(dataUpdatedStr)
		if parseErr != nil {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid X-Data-Updated-At"})
		}
		remoteState.DataUpdatedAt = parsedDataUpdatedAt
	}

	remoteFileUpdatedMs := int64(0)
	if lastUpdatedStr != "" {
		parsedLastUpdated, parseErr := parseTimestampHeader(lastUpdatedStr)
		if parseErr != nil {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid X-Last-Updated"})
		}
		remoteFileUpdatedMs = parsedLastUpdated
	}

	file, err := c.FormFile("file")
	if err != nil {
		return err
	}
	src, err := file.Open()
	if err != nil {
		return err
	}
	defer src.Close()

	// 保存先ディレクトリの作成: peer_backups/[sourceNode]/[dbName]
	destDir := filepath.Join("peer_backups", sourceNode)
	os.MkdirAll(destDir, 0755)
	destPath := filepath.Join(destDir, dbName)

	// Peerバックアップとして保存
	out, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err = io.Copy(out, src); err != nil {
		return err
	}

	// 新ヘッダー未対応の旧ノード向けフォールバック:
	// 受信ファイル内の sync_state から論理時刻を読み取る。
	if remoteState.Revision == 0 && remoteState.DataUpdatedAt == 0 {
		remoteSnapshotState, stateErr := getDBSyncStateFromFile(destPath)
		if stateErr != nil {
			log.Printf("[Sync] Failed to read remote sync state from snapshot (%s): %v", dbName, stateErr)
		} else {
			remoteState = remoteSnapshotState
			if strings.TrimSpace(remoteState.SourceNode) == "" {
				remoteState.SourceNode = sourceNode
			}
		}
	}

	shouldApply := shouldApplyRemoteSnapshot(localState, remoteState, localFileUpdatedMs, remoteFileUpdatedMs)
	if !shouldApply {
		log.Printf(
			"[Sync] Keeping local %s (local rev=%d updated=%d, remote rev=%d updated=%d). Saved peer snapshot only.",
			dbName,
			localState.Revision,
			localState.DataUpdatedAt,
			remoteState.Revision,
			remoteState.DataUpdatedAt,
		)
		return c.JSON(http.StatusOK, map[string]bool{"success": true})
	}

	log.Printf(
		"[Sync] Applying remote %s from %s (local rev=%d updated=%d -> remote rev=%d updated=%d)",
		dbName,
		sourceNode,
		localState.Revision,
		localState.DataUpdatedAt,
		remoteState.Revision,
		remoteState.DataUpdatedAt,
	)

	dbMutex.Lock()
	defer dbMutex.Unlock()

	if targetDB != nil && *targetDB != nil {
		(*targetDB).Close()
	}

	if _, statErr := os.Stat(localPath); statErr == nil {
		backupPath := localPath + ".bak"
		if backupErr := copyFile(localPath, backupPath); backupErr != nil {
			log.Printf("[Sync] Failed to backup local DB before apply (%s): %v", dbName, backupErr)
		}
	}

	// WAL/SHM が残っていると復旧後のスナップショットと不整合になる場合がある
	os.Remove(localPath + "-wal")
	os.Remove(localPath + "-shm")

	if err := copyFile(destPath, localPath); err != nil {
		log.Printf("[Sync] Failed to update local DB (%s): %v", dbName, err)
		return c.JSON(http.StatusInternalServerError, map[string]bool{"success": false})
	}

	if targetDB != nil {
		*targetDB = initDB(localPath)
	}

	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func handleSyncPushNow(c echo.Context) error {
	go pushSyncToPeers()
	return c.JSON(http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "sync push triggered",
	})
}

func runSyncLoop() {
	log.Printf("[Sync] Sync loop started. Interval: %v, Peers: %v, Threshold: %d", SyncInterval, PeerUrls, SyncWriteThreshold)
	if len(PeerUrls) == 0 {
		log.Println("[Sync] No peer URLs configured. Sync loop disabled.")
		return
	}

	log.Printf("[Sync] Requesting immediate sync push from peers on startup...")
	requestPeerPushNow()

	for {
		time.Sleep(SyncInterval)
		log.Printf("[Sync] Starting periodic sync cycle (Peers: %d)...", len(PeerUrls))
		pushSyncToPeers()
	}
}

func requestPeerPushNow() {
	for _, peerUrl := range PeerUrls {
		url := strings.TrimRight(peerUrl, "/") + "/sync/push-now"
		req, err := http.NewRequest("POST", url, nil)
		if err != nil {
			log.Printf("[Sync] Failed to prepare push-now request for %s: %v", peerUrl, err)
			continue
		}
		req.Header.Set("Authorization", "Bearer "+ApiKey)

		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			log.Printf("[Sync] Failed to request push-now from %s: %v", peerUrl, err)
			continue
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			log.Printf("[Sync] push-now rejected by %s: %s", peerUrl, resp.Status)
			continue
		}
		log.Printf("[Sync] Requested push-now from %s", peerUrl)
	}
}

func incrementSettingsWrite() {
	markDBUpdated("settings.sqlite3", settingsDB)

	syncTriggerMutex.Lock()
	settingsWriteCount++
	count := settingsWriteCount
	syncTriggerMutex.Unlock()

	if count >= SyncWriteThreshold {
		log.Printf("[Sync] Settings write count (%d) reached threshold (%d). Triggering immediate sync.", count, SyncWriteThreshold)
		triggerImmediateSync("settings")
	}
}

func incrementLicenseWrite() {
	markDBUpdated("licenses.sqlite3", licenseDB)

	syncTriggerMutex.Lock()
	licenseWriteCount++
	count := licenseWriteCount
	syncTriggerMutex.Unlock()

	if count >= SyncWriteThreshold {
		log.Printf("[Sync] License write count (%d) reached threshold (%d). Triggering immediate sync.", count, SyncWriteThreshold)
		triggerImmediateSync("license")
	}
}

func incrementAutovcWrite() {
	markDBUpdated("autovc.sqlite3", autovcDB)

	syncTriggerMutex.Lock()
	autovcWriteCount++
	count := autovcWriteCount
	syncTriggerMutex.Unlock()

	if count >= SyncWriteThreshold {
		log.Printf("[Sync] AutoVC write count (%d) reached threshold (%d). Triggering immediate sync.", count, SyncWriteThreshold)
		triggerImmediateSync("autovc")
	}
}

func triggerImmediateSync(source string) {
	syncTriggerMutex.Lock()
	switch source {
	case "settings":
		settingsWriteCount = 0
	case "license":
		licenseWriteCount = 0
	case "autovc":
		autovcWriteCount = 0
	}
	syncTriggerMutex.Unlock()

	// 非同期で実行
	go pushSyncToPeers()
}

func pushSyncToPeers() {
	dbs := []struct {
		name string
		db   *sql.DB
	}{
		{"settings.sqlite3", settingsDB},
		{"usage.sqlite3", usageDB},
		{"licenses.sqlite3", licenseDB},
		{"autovc.sqlite3", autovcDB},
	}

	tempDir, _ := os.MkdirTemp("", "layerd_sync")
	defer os.RemoveAll(tempDir)

	for _, item := range dbs {
		if item.db == nil {
			continue
		}
		tempPath := filepath.Join(tempDir, item.name)

		// 1. Snapshot 作成
		_, err := item.db.Exec(fmt.Sprintf("VACUUM INTO '%s'", tempPath))
		if err != nil {
			log.Printf("[Sync] Failed to create snapshot for %s: %v", item.name, err)
			continue
		}

		info, _ := os.Stat(tempPath)
		lastUpdatedMs := info.ModTime().UnixMilli()

		snapshotState, stateErr := getDBSyncStateFromFile(tempPath)
		if stateErr != nil {
			log.Printf("[Sync] Failed to read snapshot sync state for %s: %v", item.name, stateErr)
			snapshotState = dbSyncState{}
		}

		// 2. 各 Peer へ送信
		for _, peerUrl := range PeerUrls {
			if err := uploadFile(peerUrl+"/sync/receive?db="+item.name, tempPath, lastUpdatedMs, snapshotState); err != nil {
				log.Printf("[Sync] Failed to push %s to %s: %v", item.name, peerUrl, err)
			} else {
				log.Printf("[Sync] Successfully pushed %s to %s", item.name, peerUrl)
			}
		}
	}
}

func uploadFile(url, path string, lastUpdatedMs int64, state dbSyncState) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", filepath.Base(path))
	if err != nil {
		return err
	}
	io.Copy(part, file)
	writer.Close()

	req, err := http.NewRequest("POST", url, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+ApiKey)
	req.Header.Set("X-Source-Node", NodeName)
	req.Header.Set("X-Last-Updated", strconv.FormatInt(lastUpdatedMs, 10))
	req.Header.Set("X-Data-Revision", strconv.FormatInt(state.Revision, 10))
	req.Header.Set("X-Data-Updated-At", strconv.FormatInt(state.DataUpdatedAt, 10))

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("server returned status: %s", resp.Status)
	}
	return nil
}

func copyFile(src, dst string) error {
	source, err := os.Open(src)
	if err != nil {
		return err
	}
	defer source.Close()

	destination, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer destination.Close()
	_, err = io.Copy(destination, source)
	return err
}
