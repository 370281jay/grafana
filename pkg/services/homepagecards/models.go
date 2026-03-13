package homepagecards

import (
	"errors"
	"strings"
	"time"
)

var (
	ErrCommandValidationFailed = errors.New("command missing required fields")
	ErrHomePageCardNotFound    = errors.New("home page card not found")
)

type HomePageCard struct {
	ID           int64     `json:"id" xorm:"pk autoincr 'id'" db:"id"`
	OrgID        int64     `json:"orgId" xorm:"org_id" db:"org_id"`
	DeviceMAC    string    `json:"deviceMac" xorm:"device_mac" db:"device_mac"`
	DeviceType   string    `json:"deviceType" xorm:"device_type" db:"device_type"`
	CardName     string    `json:"cardName" xorm:"card_name" db:"card_name"`
	DashboardUID string    `json:"dashboardUid" xorm:"dashboard_uid" db:"dashboard_uid"`
	Created      time.Time `json:"created" xorm:"created" db:"created"`
	Updated      time.Time `json:"updated" xorm:"updated" db:"updated"`
}

type CreateHomePageCardCommand struct {
	OrgID        int64  `json:"orgId" xorm:"org_id"`
	DeviceMAC    string `json:"deviceMac" xorm:"device_mac"`
	DeviceType   string `json:"deviceType" xorm:"device_type"`
	CardName     string `json:"cardName" xorm:"card_name"`
	DashboardUID string `json:"dashboardUid" xorm:"dashboard_uid"`
}

func (cmd *CreateHomePageCardCommand) Validate() error {
	cmd.DeviceMAC = NormalizeMAC(cmd.DeviceMAC)
	cmd.DeviceType = strings.TrimSpace(cmd.DeviceType)
	cmd.CardName = strings.TrimSpace(cmd.CardName)
	cmd.DashboardUID = strings.TrimSpace(cmd.DashboardUID)

	if cmd.OrgID == 0 || cmd.DeviceMAC == "" || cmd.CardName == "" {
		return ErrCommandValidationFailed
	}

	return nil
}

type UpdateHomePageCardCommand struct {
	ID           int64  `json:"-"`
	OrgID        int64  `json:"orgId" xorm:"org_id"`
	DeviceMAC    string `json:"deviceMac" xorm:"device_mac"`
	DeviceType   string `json:"deviceType" xorm:"device_type"`
	CardName     string `json:"cardName" xorm:"card_name"`
	DashboardUID string `json:"dashboardUid" xorm:"dashboard_uid"`
}

func (cmd *UpdateHomePageCardCommand) Validate() error {
	cmd.DeviceMAC = NormalizeMAC(cmd.DeviceMAC)
	cmd.DeviceType = strings.TrimSpace(cmd.DeviceType)
	cmd.CardName = strings.TrimSpace(cmd.CardName)
	cmd.DashboardUID = strings.TrimSpace(cmd.DashboardUID)

	if cmd.ID == 0 || cmd.OrgID == 0 || cmd.DeviceMAC == "" || cmd.CardName == "" {
		return ErrCommandValidationFailed
	}

	return nil
}

type DeleteHomePageCardCommand struct {
	ID    int64 `json:"-"`
	OrgID int64 `json:"orgId" xorm:"org_id"`
}

func (cmd *DeleteHomePageCardCommand) Validate() error {
	if cmd.ID == 0 || cmd.OrgID == 0 {
		return ErrCommandValidationFailed
	}

	return nil
}

type GetHomePageCardsQuery struct {
	OrgID int64 `json:"orgId" xorm:"org_id"`
}

func NormalizeMAC(value string) string {
	value = strings.TrimSpace(value)
	value = strings.ReplaceAll(value, ":", "")
	value = strings.ReplaceAll(value, "-", "")
	return strings.ToUpper(value)
}
