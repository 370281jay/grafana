package devicesimpl

import (
	"context"

	"github.com/grafana/grafana/pkg/infra/db"
	"github.com/grafana/grafana/pkg/services/devices"
)

type Service struct {
	store store
}

func ProvideService(db db.DB) devices.Service {
	return &Service{store: &sqlStore{db: db}}
}

func (s *Service) List(ctx context.Context, query *devices.ListDevicesQuery) ([]*devices.Device, error) {
	return s.store.List(ctx, query)
}

func (s *Service) Get(ctx context.Context, query *devices.GetDeviceQuery) (*devices.Device, error) {
	return s.store.Get(ctx, query)
}

func (s *Service) Create(ctx context.Context, cmd *devices.CreateDeviceCommand) (*devices.Device, error) {
	if err := cmd.Validate(); err != nil {
		return nil, err
	}
	return s.store.Create(ctx, cmd)
}

func (s *Service) Update(ctx context.Context, cmd *devices.UpdateDeviceCommand) (*devices.Device, error) {
	if err := cmd.Validate(); err != nil {
		return nil, err
	}
	return s.store.Update(ctx, cmd)
}

func (s *Service) Delete(ctx context.Context, cmd *devices.DeleteDeviceCommand) error {
	if err := cmd.Validate(); err != nil {
		return err
	}
	return s.store.Delete(ctx, cmd)
}
