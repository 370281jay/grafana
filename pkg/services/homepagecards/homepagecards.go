package homepagecards

import "context"

type Service interface {
	List(context.Context, *GetHomePageCardsQuery) ([]*HomePageCard, error)
	Create(context.Context, *CreateHomePageCardCommand) (*HomePageCard, error)
	Update(context.Context, *UpdateHomePageCardCommand) (*HomePageCard, error)
	Delete(context.Context, *DeleteHomePageCardCommand) error
}
