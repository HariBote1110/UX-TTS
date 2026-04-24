package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
)

// グローバル DB を触るため、このファイルのテストは並列にしない。

func setupLayerDTestServer(t *testing.T) *echo.Echo {
	t.Helper()
	closeLayerDDatabases()

	dir := t.TempDir()
	backupDir := filepath.Join(dir, "backups")
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		t.Fatal(err)
	}

	ApiKey = "integration-test-key"
	DbDir = dir
	BackupDir = backupDir
	NodeName = "test-node"
	PeerUrls = nil
	SyncInterval = 24 * time.Hour
	SyncWriteThreshold = 99999

	if err := initialiseLayerDDatabases(); err != nil {
		t.Fatal(err)
	}

	e := newEchoWithLayerDRoutes()
	e.Logger.SetOutput(io.Discard)

	t.Cleanup(func() {
		closeLayerDDatabases()
	})

	return e
}

func authHeader() string {
	return "Bearer " + ApiKey
}

func postAuthedJSON(t *testing.T, e *echo.Echo, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("Authorization", authHeader())
	e.ServeHTTP(rec, req)
	return rec
}

func TestLayerDHTTPAuthAndRoot(t *testing.T) {
	e := setupLayerDTestServer(t)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET / = %d", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(Version)) {
		t.Fatalf("body should mention Version: %s", rec.Body.String())
	}

	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/dict/list", bytes.NewReader([]byte(`{"guildId":"g1"}`)))
	req2.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	e.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated POST /dict/list = %d, want 401", rec2.Code)
	}
}

func TestLayerDHTTPGuildDictionaryRoundTrip(t *testing.T) {
	e := setupLayerDTestServer(t)
	guildID := "guild-roundtrip-1"

	addBody := map[string]string{"guildId": guildID, "word": "hello", "readAs": "hey"}
	b, _ := json.Marshal(addBody)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/dict/add", bytes.NewReader(b))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("Authorization", authHeader())
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("dict/add: %d %s", rec.Code, rec.Body.String())
	}

	listBody := map[string]string{"guildId": guildID}
	lb, _ := json.Marshal(listBody)
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/dict/list", bytes.NewReader(lb))
	req2.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req2.Header.Set("Authorization", authHeader())
	e.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("dict/list: %d", rec2.Code)
	}
	var rows []map[string]interface{}
	if err := json.Unmarshal(rec2.Body.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d: %v", len(rows), rows)
	}
	if rows[0]["word"] != "hello" || rows[0]["read_as"] != "hey" {
		t.Fatalf("unexpected row: %v", rows[0])
	}
}

func TestLayerDHTTPUserPersonalDictionaryLimit(t *testing.T) {
	e := setupLayerDTestServer(t)
	uid := "user-limit-1"

	for i := 0; i < userPersonalDictionaryMaxEntries; i++ {
		body := map[string]string{
			"userId": uid,
			"word":   string(rune('a' + i)),
			"readAs": "x",
		}
		b, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/user-dict/add", bytes.NewReader(b))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		req.Header.Set("Authorization", authHeader())
		e.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("add %d: %d %s", i, rec.Code, rec.Body.String())
		}
		var resp map[string]interface{}
		_ = json.Unmarshal(rec.Body.Bytes(), &resp)
		if resp["success"] != true {
			t.Fatalf("add %d: %v", i, resp)
		}
	}

	overflow := map[string]string{"userId": uid, "word": "zzz", "readAs": "y"}
	ob, _ := json.Marshal(overflow)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/user-dict/add", bytes.NewReader(ob))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("Authorization", authHeader())
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("overflow add: %d", rec.Code)
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp["success"] != false || resp["error"] != "limit" {
		t.Fatalf("expected limit failure, got %v", resp)
	}
}

func TestLayerDHTTPUsageGetCreatesRow(t *testing.T) {
	e := setupLayerDTestServer(t)
	gid := "guild-usage-1"
	body := map[string]string{"guildId": gid}
	b, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/usage/get", bytes.NewReader(b))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("Authorization", authHeader())
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("usage/get: %d %s", rec.Code, rec.Body.String())
	}
	var out map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out["guild_id"] != gid {
		t.Fatalf("guild_id: %v", out["guild_id"])
	}
	if out["count"].(float64) != 0 {
		t.Fatalf("count: %v", out["count"])
	}
}

func TestLayerDHTTPUserSettingsGetCreatesRow(t *testing.T) {
	e := setupLayerDTestServer(t)
	gid := "guild-user-1"
	uid := "user-1"

	rec := postAuthedJSON(t, e, "/settings/user/get", map[string]string{
		"guildId": gid,
		"userId":  uid,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("settings/user/get: %d %s", rec.Code, rec.Body.String())
	}
	var out map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out["guild_id"] != gid || out["user_id"] != uid {
		t.Fatalf("ids: %v", out)
	}
	if out["speaker_type"] != "voicevox" {
		t.Fatalf("speaker_type: %v", out["speaker_type"])
	}
	if out["auto_join"].(float64) != 0 || out["active_speech"].(float64) != 0 {
		t.Fatalf("defaults: %v", out)
	}
	if out["guild_default_speaker_type"] != "voicevox" {
		t.Fatalf("guild_default_speaker_type: %v", out["guild_default_speaker_type"])
	}
}

func TestLayerDHTTPUserSettingsUpdateSpeakerRoundTrip(t *testing.T) {
	e := setupLayerDTestServer(t)
	gid := "guild-user-2"
	uid := "user-2"

	postAuthedJSON(t, e, "/settings/user/get", map[string]string{"guildId": gid, "userId": uid})

	up := postAuthedJSON(t, e, "/settings/user/update-speaker", map[string]interface{}{
		"guildId":   gid,
		"userId":    uid,
		"speakerId": 3,
		"type":      "OJT",
	})
	if up.Code != http.StatusOK {
		t.Fatalf("update-speaker: %d %s", up.Code, up.Body.String())
	}

	rec := postAuthedJSON(t, e, "/settings/user/get", map[string]string{"guildId": gid, "userId": uid})
	if rec.Code != http.StatusOK {
		t.Fatalf("get after update: %d", rec.Code)
	}
	var out map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out["speaker_type"] != "ojt" {
		t.Fatalf("want ojt, got %v", out["speaker_type"])
	}
	if sid, ok := out["speaker_id"].(float64); !ok || sid != 3 {
		t.Fatalf("speaker_id: %v", out["speaker_id"])
	}
}

func TestLayerDHTTPGuildDefaultSpeakerVisibleOnUserGet(t *testing.T) {
	e := setupLayerDTestServer(t)
	gid := "guild-gdef-1"
	uid := "user-gdef-1"

	postAuthedJSON(t, e, "/settings/guild/update-default-speaker", map[string]interface{}{
		"guildId":   gid,
		"speakerId": 88,
		"type":      "voicevox",
	})

	rec := postAuthedJSON(t, e, "/settings/user/get", map[string]string{"guildId": gid, "userId": uid})
	if rec.Code != http.StatusOK {
		t.Fatal(rec.Body.String())
	}
	var out map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if gds, ok := out["guild_default_speaker_id"].(float64); !ok || gds != 88 {
		t.Fatalf("guild_default_speaker_id: %v", out["guild_default_speaker_id"])
	}
}

func TestLayerDHTTPJoinRequestCreateDispatchComplete(t *testing.T) {
	e := setupLayerDTestServer(t)
	gid := "guild-jr-1"
	voice := "vc-1"
	owner := "bot-owner-1"

	cr := postAuthedJSON(t, e, "/join-requests/create", map[string]interface{}{
		"guildId":        gid,
		"voiceChannelId": voice,
		"textChannelId":  "tc-1",
		"requestedBy":    "user-req-1",
		"ttlSeconds":     600,
	})
	if cr.Code != http.StatusOK {
		t.Fatalf("create: %d %s", cr.Code, cr.Body.String())
	}
	var created map[string]interface{}
	if err := json.Unmarshal(cr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created["success"] != true {
		t.Fatalf("create: %v", created)
	}
	id, ok := created["id"].(float64)
	if !ok || id <= 0 {
		t.Fatalf("id: %v", created["id"])
	}

	dp := postAuthedJSON(t, e, "/join-requests/dispatch", map[string]interface{}{
		"ownerId":          owner,
		"busyGuildIds":     []string{},
		"eligibleGuildIds": []string{gid},
		"claimTtlSeconds":  90,
	})
	if dp.Code != http.StatusOK {
		t.Fatalf("dispatch: %d %s", dp.Code, dp.Body.String())
	}
	var disp map[string]interface{}
	if err := json.Unmarshal(dp.Body.Bytes(), &disp); err != nil {
		t.Fatal(err)
	}
	if disp["status"] != "claimed" {
		t.Fatalf("dispatch status: %v", disp)
	}
	if disp["assigned_owner_id"] != owner {
		t.Fatalf("owner: %v", disp["assigned_owner_id"])
	}

	co := postAuthedJSON(t, e, "/join-requests/complete", map[string]interface{}{
		"id":      int64(id),
		"ownerId": owner,
		"success": true,
		"message": "ok",
	})
	if co.Code != http.StatusOK {
		t.Fatalf("complete: %d %s", co.Code, co.Body.String())
	}
	var done map[string]interface{}
	if err := json.Unmarshal(co.Body.Bytes(), &done); err != nil {
		t.Fatal(err)
	}
	if done["completed"] != true {
		t.Fatalf("complete: %v", done)
	}
}

func TestLayerDHTTPVoiceClaimClaimGetRelease(t *testing.T) {
	e := setupLayerDTestServer(t)
	gid := "guild-vc-1"
	voice := "voice-claim-1"
	owner := "owner-1"

	cl := postAuthedJSON(t, e, "/vc-claims/claim", map[string]interface{}{
		"guildId":        gid,
		"voiceChannelId": voice,
		"ownerId":        owner,
		"ttlSeconds":     120,
	})
	if cl.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", cl.Code, cl.Body.String())
	}
	var claimed map[string]interface{}
	if err := json.Unmarshal(cl.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}
	if claimed["claimed"] != true {
		t.Fatalf("claim: %v", claimed)
	}

	g := postAuthedJSON(t, e, "/vc-claims/get", map[string]string{
		"guildId":        gid,
		"voiceChannelId": voice,
	})
	if g.Code != http.StatusOK {
		t.Fatalf("get: %d", g.Code)
	}
	var st map[string]interface{}
	if err := json.Unmarshal(g.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if st["owner_id"] != owner {
		t.Fatalf("owner_id: %v", st["owner_id"])
	}

	rel := postAuthedJSON(t, e, "/vc-claims/release", map[string]string{
		"guildId":        gid,
		"voiceChannelId": voice,
		"ownerId":        owner,
	})
	if rel.Code != http.StatusOK {
		t.Fatalf("release: %d %s", rel.Code, rel.Body.String())
	}
	var relOut map[string]interface{}
	if err := json.Unmarshal(rel.Body.Bytes(), &relOut); err != nil {
		t.Fatal(err)
	}
	if relOut["released"] != true {
		t.Fatalf("released: %v", relOut)
	}
}

func TestLayerDHTTPChannelPairRoundTrip(t *testing.T) {
	e := setupLayerDTestServer(t)
	gid := "guild-pair-1"
	voice := "v-1"
	text := "t-1"

	add := postAuthedJSON(t, e, "/channels/pair/add", map[string]string{
		"guildId": gid,
		"voiceId": voice,
		"textId":  text,
	})
	if add.Code != http.StatusOK {
		t.Fatalf("pair/add: %d %s", add.Code, add.Body.String())
	}

	get := postAuthedJSON(t, e, "/channels/pair/get", map[string]string{
		"guildId": gid,
		"voiceId": voice,
	})
	if get.Code != http.StatusOK {
		t.Fatalf("pair/get: %d", get.Code)
	}
	var pair map[string]interface{}
	if err := json.Unmarshal(get.Body.Bytes(), &pair); err != nil {
		t.Fatal(err)
	}
	if pair["voice_channel_id"] != voice || pair["text_channel_id"] != text {
		t.Fatalf("pair: %v", pair)
	}

	all := postAuthedJSON(t, e, "/channels/pair/all", map[string]string{"guildId": gid})
	if all.Code != http.StatusOK {
		t.Fatalf("pair/all: %d", all.Code)
	}
	var pairs []map[string]interface{}
	if err := json.Unmarshal(all.Body.Bytes(), &pairs); err != nil {
		t.Fatal(err)
	}
	if len(pairs) != 1 {
		t.Fatalf("want 1 pair, got %d", len(pairs))
	}
}
