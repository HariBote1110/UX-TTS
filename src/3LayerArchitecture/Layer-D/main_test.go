package main

import (
	"testing"
)

func TestNormaliseSpeakerType(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   string
		want string
	}{
		{"", "voicevox"},
		{"  ", "voicevox"},
		{"OJT", "ojt"},
		{" ojt ", "ojt"},
		{"VoiceVox", "voicevox"},
		{"VOICEVOX", "voicevox"},
		{"other", "voicevox"},
	}
	for _, tc := range cases {
		got := normaliseSpeakerType(tc.in)
		if got != tc.want {
			t.Errorf("normaliseSpeakerType(%q) = %q; want %q", tc.in, got, tc.want)
		}
	}
}

func TestParseTimestampHeader(t *testing.T) {
	t.Parallel()
	if _, err := parseTimestampHeader(""); err == nil {
		t.Fatal("expected error for empty string")
	}
	if _, err := parseTimestampHeader("   "); err == nil {
		t.Fatal("expected error for whitespace-only")
	}

	ms, err := parseTimestampHeader("1700000000")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if ms != 1700000000*1000 {
		t.Fatalf("10-digit second value: got %d", ms)
	}

	ms2, err := parseTimestampHeader("1700000000123")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if ms2 != 1700000000123 {
		t.Fatalf("millisecond value: got %d", ms2)
	}
}

func TestShouldApplyRemoteSnapshot(t *testing.T) {
	t.Parallel()
	local := dbSyncState{Revision: 1, DataUpdatedAt: 100}
	remote := dbSyncState{Revision: 2, DataUpdatedAt: 100}
	if !shouldApplyRemoteSnapshot(local, remote, 0, 0) {
		t.Fatal("higher remote revision should apply")
	}

	local2 := dbSyncState{Revision: 5, DataUpdatedAt: 200}
	remote2 := dbSyncState{Revision: 5, DataUpdatedAt: 300}
	if !shouldApplyRemoteSnapshot(local2, remote2, 0, 0) {
		t.Fatal("same revision but newer remote data_updated_at should apply")
	}

	local3 := dbSyncState{Revision: 0, DataUpdatedAt: 0}
	remote3 := dbSyncState{Revision: 0, DataUpdatedAt: 500}
	if !shouldApplyRemoteSnapshot(local3, remote3, 100, 1000) {
		t.Fatal("no local updated timestamp but remote has data_updated_at > local file mtime should apply")
	}

	local4 := dbSyncState{Revision: 10, DataUpdatedAt: 1000}
	remote4 := dbSyncState{Revision: 9, DataUpdatedAt: 900}
	if shouldApplyRemoteSnapshot(local4, remote4, 0, 999999999) {
		t.Fatal("older remote revision should not apply when both have revision")
	}
}

func TestQuoteIdentifier(t *testing.T) {
	t.Parallel()
	if quoteIdentifier(`foo"bar`) != `"foo""bar"` {
		t.Fatalf("unexpected quote: %s", quoteIdentifier(`foo"bar`))
	}
	if quoteIdentifier("plain") != `"plain"` {
		t.Fatalf("unexpected quote: %s", quoteIdentifier("plain"))
	}
}

func TestListColumnNames(t *testing.T) {
	t.Parallel()
	m := map[string]bool{"z": true, "a": true, "m": true}
	names := listColumnNames(m)
	if len(names) != 3 {
		t.Fatalf("len = %d", len(names))
	}
	if names[0] != "a" || names[1] != "m" || names[2] != "z" {
		t.Fatalf("not sorted: %v", names)
	}
}

func TestSelectColumnOrDefault(t *testing.T) {
	t.Parallel()
	cols := map[string]bool{"id": true}
	if selectColumnOrDefault(cols, "id", "fallback") != "id" {
		t.Fatal()
	}
	if selectColumnOrDefault(cols, "missing", "fallback") != "fallback" {
		t.Fatal()
	}
}
