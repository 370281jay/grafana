package devices

import (
	"errors"
	"strings"
	"time"
)

var (
	ErrCommandValidationFailed = errors.New("device command missing required fields")
	ErrDeviceNotFound         = errors.New("device not found")
)

type Device struct {
	ID          int64     `json:"id" xorm:"pk autoincr 'id'" db:"id"`
	OrgID       int64     `json:"orgId" xorm:"org_id" db:"org_id"`
	Name        string    `json:"name" xorm:"name" db:"name"`
	DeviceMAC   string    `json:"deviceMac" xorm:"device_mac" db:"device_mac"`
	DeviceType  string    `json:"deviceType" xorm:"device_type" db:"device_type"`
	Description string    `json:"description" xorm:"description" db:"description"`
	Created     time.Time `json:"created" xorm:"created" db:"created"`
	Updated     time.Time `json:"updated" xorm:"updated" db:"updated"`
}

type ListDevicesQuery struct {
	OrgID int64 `json:"orgId"`
}

type GetDeviceQuery struct {
	OrgID int64 `json:"orgId"`
	ID    int64 `json:"id"`
}

type CreateDeviceCommand struct {
	OrgID       int64  `json:"orgId"`
	Name        string `json:"name"`
	DeviceMAC   string `json:"deviceMac"`
	DeviceType  string `json:"deviceType"`
	Description string `json:"description"`
}

func (cmd *CreateDeviceCommand) Validate() error {
	cmd.Name = strings.TrimSpace(cmd.Name)
	cmd.DeviceMAC = NormalizeMAC(cmd.DeviceMAC)
	cmd.DeviceType = strings.TrimSpace(cmd.DeviceType)
	cmd.Description = strings.TrimSpace(cmd.Description)

	if cmd.OrgID == 0 || cmd.Name == "" || cmd.DeviceMAC == "" {
		return ErrCommandValidationFailed
	}

	return nil
}

type UpdateDeviceCommand struct {
	ID          int64  `json:"id"`
	OrgID       int64  `json:"orgId"`
	Name        string `json:"name"`
	DeviceMAC   string `json:"deviceMac"`
	DeviceType  string `json:"deviceType"`
	Description string `json:"description"`
}

func (cmd *UpdateDeviceCommand) Validate() error {
	cmd.Name = strings.TrimSpace(cmd.Name)
	cmd.DeviceMAC = NormalizeMAC(cmd.DeviceMAC)
	cmd.DeviceType = strings.TrimSpace(cmd.DeviceType)
	cmd.Description = strings.TrimSpace(cmd.Description)

	if cmd.ID == 0 || cmd.OrgID == 0 || cmd.Name == "" || cmd.DeviceMAC == "" {
		return ErrCommandValidationFailed
	}

	return nil
}

type DeleteDeviceCommand struct {
	ID    int64 `json:"id"`
	OrgID int64 `json:"orgId"`
}

func (cmd *DeleteDeviceCommand) Validate() error {
	if cmd.ID == 0 || cmd.OrgID == 0 {
		return ErrCommandValidationFailed
	}
	return nil
}

func NormalizeMAC(value string) string {
	value = strings.TrimSpace(value)
	value = strings.ReplaceAll(value, ":", "")
	value = strings.ReplaceAll(value, "-", "")
	return strings.ToUpper(value)
}
