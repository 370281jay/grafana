package devices

import "context"

type Service interface {
	List(context.Context, *ListDevicesQuery) ([]*Device, error)
	Get(context.Context, *GetDeviceQuery) (*Device, error)
	Create(context.Context, *CreateDeviceCommand) (*Device, error)
	Update(context.Context, *UpdateDeviceCommand) (*Device, error)
	Delete(context.Context, *DeleteDeviceCommand) error
}
