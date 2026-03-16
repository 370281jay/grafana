package devicesimpl

import (
	"context"

	"github.com/grafana/grafana/pkg/infra/db"
	"github.com/grafana/grafana/pkg/services/devices"
)

type sqlStore struct {
	db db.DB
}

func (s *sqlStore) List(ctx context.Context, query *devices.ListDevicesQuery) ([]*devices.Device, error) {
	var result []*devices.Device
	err := s.db.WithDbSession(ctx, func(sess *db.Session) error {
		return sess.Where("org_id = ?", query.OrgID).Asc("id").Find(&result)
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *sqlStore) Get(ctx context.Context, query *devices.GetDeviceQuery) (*devices.Device, error) {
	device := &devices.Device{}
	err := s.db.WithDbSession(ctx, func(sess *db.Session) error {
		exists, err := sess.Where("id = ? AND org_id = ?", query.ID, query.OrgID).Get(device)
		if err != nil {
			return err
		}
		if !exists {
			return devices.ErrDeviceNotFound
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return device, nil
}

func (s *sqlStore) Create(ctx context.Context, cmd *devices.CreateDeviceCommand) (*devices.Device, error) {
	entity := &devices.Device{
		OrgID:       cmd.OrgID,
		Name:        cmd.Name,
		DeviceMAC:   cmd.DeviceMAC,
		DeviceType:  cmd.DeviceType,
		Description: cmd.Description,
	}
	err := s.db.WithTransactionalDbSession(ctx, func(sess *db.Session) error {
		_, err := sess.Insert(entity)
		return err
	})
	if err != nil {
		return nil, err
	}
	return entity, nil
}

func (s *sqlStore) Update(ctx context.Context, cmd *devices.UpdateDeviceCommand) (*devices.Device, error) {
	entity := &devices.Device{}
	err := s.db.WithTransactionalDbSession(ctx, func(sess *db.Session) error {
		exists, err := sess.Where("id = ? AND org_id = ?", cmd.ID, cmd.OrgID).Get(entity)
		if err != nil {
			return err
		}
		if !exists {
			return devices.ErrDeviceNotFound
		}

		entity.Name = cmd.Name
		entity.DeviceMAC = cmd.DeviceMAC
		entity.DeviceType = cmd.DeviceType
		entity.Description = cmd.Description

		_, err = sess.ID(entity.ID).AllCols().Update(entity)
		return err
	})
	if err != nil {
		return nil, err
	}
	return entity, nil
}

func (s *sqlStore) Delete(ctx context.Context, cmd *devices.DeleteDeviceCommand) error {
	return s.db.WithTransactionalDbSession(ctx, func(sess *db.Session) error {
		entity := &devices.Device{}
		exists, err := sess.Where("id = ? AND org_id = ?", cmd.ID, cmd.OrgID).Get(entity)
		if err != nil {
			return err
		}
		if !exists {
			return devices.ErrDeviceNotFound
		}

		_, err = sess.ID(entity.ID).Delete(entity)
		return err
	})
}
