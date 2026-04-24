package main

import (
	"crypto/md5"
	"fmt"
	"testing"
)

func GenerateHash(text string, speakerId int, speed float64, pitch float64) string {
	s := fmt.Sprintf("%s:%d:%v:%v", text, speakerId, speed, pitch)
	data := []byte(s)
	return fmt.Sprintf("%x", md5.Sum(data))
}

func TestHashCompatibility(t *testing.T) {
	tests := []struct {
		text      string
		speakerId int
		speed     float64
		pitch     float64
		expected  string // Node.js で生成した期待値
	}{
		{"こんにちは", 1, 1.0, 0.0, ""}, // あとで Node.js で確認して埋める
	}

	for _, tt := range tests {
		actual := GenerateHash(tt.text, tt.speakerId, tt.speed, tt.pitch)
		fmt.Printf("Input: %s, %d, %v, %v -> Hash: %s\n", tt.text, tt.speakerId, tt.speed, tt.pitch, actual)
	}
}
