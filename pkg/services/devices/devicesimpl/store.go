package devicesimpl

import (
	"context"

	"github.com/grafana/grafana/pkg/services/devices"
)

type store interface {
	List(context.Context, *devices.ListDevicesQuery) ([]*devices.Device, error)
	Get(context.Context, *devices.GetDeviceQuery) (*devices.Device, error)
	Create(context.Context, *devices.CreateDeviceCommand) (*devices.Device, error)
	Update(context.Context, *devices.UpdateDeviceCommand) (*devices.Device, error)
	Delete(context.Context, *devices.DeleteDeviceCommand) error
}
