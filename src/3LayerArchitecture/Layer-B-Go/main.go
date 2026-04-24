package main

import (
	"crypto/md5"
	"database/sql"
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/joho/godotenv"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	_ "modernc.org/sqlite"
)

// 設定
var (
	MaxCacheBytes    int64 = 1024 * 1024 * 1024 // 1GB (default)
	CacheThreshold         = 2
	ApiKey                 = ""
	DebugMode              = false
	DbPath                 = ""
	CacheDir               = ""
	RequestCounters  = make(map[string]int)
	CountersMutex    sync.Mutex
)

// データ構造
type SearchRequest struct {
	Text      string  `json:"text"`
	SpeakerID int     `json:"speakerId"`
	Speed     float64 `json:"speed"`
	Pitch     float64 `json:"pitch"`
}

type SaveRequest struct {
	Text        string  `json:"text"`
	SpeakerID   int     `json:"speakerId"`
	Speed       float64 `json:"speed"`
	Pitch       float64 `json:"pitch"`
	AudioBase64 string  `json:"audioBase64"`
}

func main() {
	// .env 読み込み
	_ = godotenv.Load()

	// 設定の初期化
	if mb, err := strconv.ParseInt(os.Getenv("MAX_CACHE_SIZE_MB"), 10, 64); err == nil {
		MaxCacheBytes = mb * 1024 * 1024
	}
	if key := os.Getenv("API_KEY"); key != "" {
		ApiKey = key
	}
	DebugMode = os.Getenv("DEBUG_LOG") == "true"

	// パス設定 (Node.js 版の構造を継承)
	execPath, _ := os.Getwd()
	DbPath = filepath.Join(execPath, "database", "cache.sqlite3")
	CacheDir = filepath.Join(execPath, "audio_cache")

	// ディレクトリ作成
	os.MkdirAll(filepath.Dir(DbPath), 0755)
	os.MkdirAll(CacheDir, 0755)

	// DB 初期化
	db, err := sql.Open("sqlite", DbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS audio_cache (
			text_hash TEXT,
			speaker_id INTEGER,
			speed REAL,
			pitch REAL,
			file_path TEXT PRIMARY KEY,
			last_accessed INTEGER,
			file_size INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_text_hash ON audio_cache(text_hash);
		CREATE INDEX IF NOT EXISTS idx_last_accessed ON audio_cache(last_accessed);
	`)
	if err != nil {
		log.Fatal(err)
	}

	// Echo インスタンス
	e := echo.New()
	e.HideBanner = true
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	e.Use(middleware.CORS())

	// 定期クリーンアップ (1時間ごと)
	go func() {
		for {
			runCacheCleanup(db)
			time.Sleep(1 * time.Hour)
		}
	}()

	// カウンター掃除 (1時間ごと)
	go func() {
		for {
			time.Sleep(1 * time.Hour)
			CountersMutex.Lock()
			RequestCounters = make(map[string]int)
			CountersMutex.Unlock()
			debugLog("[System] Request counters cleared.")
		}
	}()

	// ルーティング
	e.GET("/", func(c echo.Context) error {
		return c.String(http.StatusOK, "💾 Layer-B (Cache Service) Go Version")
	})

	e.GET("/debug/toggle", func(c echo.Context) error {
		DebugMode = !DebugMode
		return c.String(http.StatusOK, fmt.Sprintf("Debug Log: %v", DebugMode))
	})

	// 認証ミドルウェア
	auth := func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			authHeader := c.Request().Header.Get("Authorization")
			if authHeader != "Bearer "+ApiKey {
				return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
			}
			return next(c)
		}
	}

	// API エンドポイント
	e.POST("/cache/search", handleSearch(db), auth)
	e.POST("/cache/save", handleSave(db), auth)

	// 起動
	port := os.Getenv("PORT")
	if port == "" {
		port = "5501"
	}
	log.Printf("💾 Layer-B (Cache) Go Version starting on port %s", port)
	e.Logger.Fatal(e.Start(":" + port))
}

// ハッシュ生成 (Node.js と完全互換)
func generateHash(text string, speakerId int, speed float64, pitch float64) string {
	// Node.js: crypto.createHash('md5').update(`${text}:${speakerId}:${speed}:${pitch}`).digest('hex')
	// 浮動小数点のフォーマットに注意。Node.js のデフォルト (ToString) は、小数点以下が0なら整数のように振る舞う。
	// ここでは %v を使うことで近い挙動にするが、厳密には検証が必要。
	s := fmt.Sprintf("%s:%d:%v:%v", text, speakerId, speed, pitch)
	data := []byte(s)
	return fmt.Sprintf("%x", md5.Sum(data))
}

func handleSearch(db *sql.DB) echo.HandlerFunc {
	return func(c echo.Context) error {
		req := new(SearchRequest)
		if err := c.Bind(req); err != nil {
			return err
		}

		hash := generateHash(req.Text, req.SpeakerID, req.Speed, req.Pitch)

		var filePath string
		err := db.QueryRow(`
			SELECT file_path FROM audio_cache 
			WHERE text_hash = ? AND speaker_id = ? AND speed = ? AND pitch = ?
		`, hash, req.SpeakerID, req.Speed, req.Pitch).Scan(&filePath)

		if err == nil {
			// ファイル存在確認
			fileName := filepath.Base(filePath)
			realPath := filepath.Join(CacheDir, fileName)

			if _, err := os.Stat(realPath); err == nil {
				// HIT: 最終アクセス更新
				now := time.Now().UnixMilli()
				db.Exec("UPDATE audio_cache SET last_accessed = ? WHERE file_path = ?", now, filePath)
				debugLog(fmt.Sprintf("[HIT] \"%s...\"", truncate(req.Text, 10)))

				return c.File(realPath)
			} else {
				// 実体がないレコードは削除
				db.Exec("DELETE FROM audio_cache WHERE file_path = ?", filePath)
			}
		}

		// MISS: カウンター処理
		CountersMutex.Lock()
		count := RequestCounters[hash] + 1
		RequestCounters[hash] = count
		CountersMutex.Unlock()

		shouldCache := count >= CacheThreshold
		debugLog(fmt.Sprintf("[MISS] \"%s...\" (Count: %d/%d)", truncate(req.Text, 10), count, CacheThreshold))

		return c.JSON(http.StatusNotFound, map[string]interface{}{
			"message":     "Not found",
			"shouldCache": shouldCache,
		})
	}
}

func handleSave(db *sql.DB) echo.HandlerFunc {
	return func(c echo.Context) error {
		req := new(SaveRequest)
		if err := c.Bind(req); err != nil {
			return err
		}

		if req.AudioBase64 == "" {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "No data"})
		}

		hash := generateHash(req.Text, req.SpeakerID, req.Speed, req.Pitch)
		fileName := hash + ".wav"
		filePath := filepath.Join(CacheDir, fileName)

		// Base64 デコード
		data, err := base64.StdEncoding.DecodeString(req.AudioBase64)
		if err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Decode Error"})
		}

		// ファイル保存
		err = os.WriteFile(filePath, data, 0644)
		if err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Save Error"})
		}

		fileSize := int64(len(data))
		now := time.Now().UnixMilli()

		_, err = db.Exec(`
			INSERT OR REPLACE INTO audio_cache 
			(text_hash, speaker_id, speed, pitch, file_path, last_accessed, file_size)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`, hash, req.SpeakerID, req.Speed, req.Pitch, filePath, now, fileSize)

		if err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "DB Error"})
		}

		debugLog(fmt.Sprintf("[SAVED] \"%s...\"", truncate(req.Text, 10)))
		return c.JSON(http.StatusOK, map[string]interface{}{"success": true})
	}
}

func runCacheCleanup(db *sql.DB) {
	rows, err := db.Query("SELECT file_path, file_size FROM audio_cache ORDER BY last_accessed ASC")
	if err != nil {
		log.Printf("[Cache Cleanup Error] %v", err)
		return
	}
	defer rows.Close()

	var currentSize int64 = 0
	type entry struct {
		dbPath      string
		currentPath string
		fileSize    int64
	}
	var validEntries []entry

	for rows.Next() {
		var dPath string
		var size int64
		if err := rows.Scan(&dPath, &size); err != nil {
			continue
		}

		fileName := filepath.Base(dPath)
		currentPath := filepath.Join(CacheDir, fileName)

		if _, err := os.Stat(currentPath); err == nil {
			currentSize += size
			validEntries = append(validEntries, entry{dPath, currentPath, size})
		} else {
			db.Exec("DELETE FROM audio_cache WHERE file_path = ?", dPath)
		}
	}

	if currentSize > MaxCacheBytes {
		log.Printf("[Cache Cleanup] Size limit exceeded (%.2fMB). Cleaning...", float64(currentSize)/1024/1024)
		deletedCount := 0
		for _, e := range validEntries {
			if currentSize <= MaxCacheBytes {
				break
			}
			err := os.Remove(e.currentPath)
			if err == nil || os.IsNotExist(err) {
				db.Exec("DELETE FROM audio_cache WHERE file_path = ?", e.dbPath)
				currentSize -= e.fileSize
				deletedCount++
			}
		}
		log.Printf("[Cache Cleanup] Deleted %d files.", deletedCount)
	}
}

func debugLog(message string) {
	if DebugMode {
		log.Printf("[%s] %s", time.Now().Format("15:04:05"), message)
	}
}

func truncate(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}
